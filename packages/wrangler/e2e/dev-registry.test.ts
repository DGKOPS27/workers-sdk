import { setTimeout } from "node:timers/promises";
import dedent from "ts-dedent";
import { fetch } from "undici";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WranglerE2ETestHelper } from "./helpers/e2e-wrangler-test";
import { fetchText } from "./helpers/fetch-text";
import { generateResourceName } from "./helpers/generate-resource-name";
import { seed as baseSeed, makeRoot } from "./helpers/setup";
import type { RequestInit } from "undici";

async function fetchJson<T>(url: string, info?: RequestInit): Promise<T> {
	return vi.waitFor(
		async () => {
			const text: string = await fetch(url, {
				headers: { "MF-Disable-Pretty-Error": "true" },
				...info,
			}).then((r) => r.text());
			console.log(text);
			return JSON.parse(text) as T;
		},
		{ timeout: 5_000, interval: 250 }
	);
}

describe.each([
	{ cmd: "wrangler dev --x-registry" },
	{ cmd: "wrangler dev --no-x-registry" },
])("dev registry $cmd", ({ cmd }) => {
	let workerName: string;
	let workerName2: string;
	let workerName3: string;
	let a: string;
	let b: string;
	let c: string;
	let helper: WranglerE2ETestHelper;

	beforeEach(async () => {
		workerName = generateResourceName("worker");
		workerName2 = generateResourceName("worker");
		workerName3 = generateResourceName("worker");
		helper = new WranglerE2ETestHelper();
		a = await makeRoot();
		await baseSeed(a, {
			"wrangler.toml": dedent`
					name = "${workerName}"
					main = "src/index.ts"
					compatibility_date = "2023-01-01"
			`,
			"src/index.ts": dedent/* javascript */ `
				export default {
					fetch(req, env) {
                        const url = new URL(req.url)
                        if (url.pathname === "/do") {
                            const id = env.MY_DO.idFromName(url.pathname);
                            const stub = env.MY_DO.get(id);
                            return stub.fetch(req);
                        }
                        if (url.pathname === "/service") {
                            return env.CEE.fetch(req);
                        }
						return env.BEE.fetch(req);
					},
				};

                export class MyDurableObject implements DurableObject {
                    constructor(public state: DurableObjectState) {}

                    async fetch(request: Request) {
                        if (request.headers.has("X-Reset-Count")) {
                            await this.state.storage.put("count", 0);
                        }
                        let count: number = (await this.state.storage.get("count")) || 0;
                        await this.state.storage.put("count", ++count);
                        return Response.json({ count, id: this.state.id.toString() });
                    }
                }
				`,
			"package.json": dedent`
					{
						"name": "a",
						"version": "0.0.0",
						"private": true
					}
					`,
		});

		b = await makeRoot();
		await baseSeed(b, {
			"wrangler.toml": dedent`
					name = "${workerName2}"
					main = "src/index.ts"
					compatibility_date = "2023-01-01"


                    [durable_objects]
                    bindings = [
                        { name = "REFERENCED_DO", class_name = "MyDurableObject", script_name = "${workerName}" }
                    ]
			`,
			"src/index.ts": dedent/* javascript */ `
				export default{
					fetch(req, env) {
                        const url = new URL(req.url)
                        if (url.pathname === "/do") {
                            const id = env.REFERENCED_DO.idFromName(url.pathname);
                            const stub = env.REFERENCED_DO.get(id);
                            return stub.fetch(req);
                        }
						return new Response("hello world");
					},
				};
			`,
			"package.json": dedent`
					{
						"name": "b",
						"version": "0.0.0",
						"private": true
					}
					`,
		});

		c = await makeRoot();
		await baseSeed(c, {
			"wrangler.toml": dedent`
					name = "${workerName3}"
					main = "src/index.ts"
			`,
			"src/index.ts": dedent/* javascript */ `
                addEventListener("fetch", (event) => {
                    event.respondWith(new Response("Hello from service worker"));
                });
			`,
			"package.json": dedent`
					{
						"name": "c",
						"version": "0.0.0",
						"private": true
					}
					`,
		});
	});

	describe("module workers", () => {
		beforeEach(async () => {
			await baseSeed(a, {
				"wrangler.toml": dedent`
						name = "${workerName}"
						main = "src/index.ts"
						compatibility_date = "2023-01-01"

						[[services]]
						binding = "BEE"
						service = '${workerName2}'
				`,
			});
		});
		it("can fetch b", async () => {
			const worker = helper.runLongLived(cmd, { cwd: b });

			const { url } = await worker.waitForReady();

			await expect(fetch(url).then((r) => r.text())).resolves.toBe(
				"hello world"
			);
		});

		it("can fetch b through a (start b, start a)", async () => {
			const workerB = helper.runLongLived(cmd, { cwd: b });
			// We don't need b's URL, but ensure that b starts up before a
			await workerB.waitForReady();

			const workerA = helper.runLongLived(cmd, { cwd: a });
			const [{ url }] = await Promise.all([
				workerA.waitForReady(),
				workerA.readUntil(/- BEE: 🟢/),
			]);

			// Give the dev registry some time to settle
			await setTimeout(500);

			await expect(fetchText(url)).resolves.toBe("hello world");
		});

		it("can fetch b through a (start a, start b)", async () => {
			const workerA = helper.runLongLived(cmd, { cwd: a });
			const { url } = await workerA.waitForReady();

			const workerB = helper.runLongLived(cmd, { cwd: b });
			await Promise.all([
				workerB.waitForReady(),
				workerA.readUntil(/- BEE: 🟢/),
			]);
			// Give the dev registry some time to settle
			await setTimeout(500);

			await expect(fetchText(url)).resolves.toBe("hello world");
		});
	});

	describe("service workers", () => {
		beforeEach(async () => {
			await baseSeed(a, {
				"wrangler.toml": dedent`
					name = "${workerName}"
					main = "src/index.ts"
					compatibility_date = "2023-01-01"

                    [[services]]
					binding = "CEE"
					service = '${workerName3}'
			`,
			});
		});

		it("can fetch service worker c through a (start c, start a)", async () => {
			const workerC = helper.runLongLived(cmd, { cwd: c });
			// We don't need c's URL, but ensure that c starts up before a
			await workerC.waitForReady();

			const workerA = helper.runLongLived(cmd, { cwd: a });

			const [{ url }] = await Promise.all([
				workerA.waitForReady(),
				workerA.readUntil(/- CEE: 🟢/),
			]);
			// Give the dev registry some time to settle
			await setTimeout(500);

			await expect(fetchText(`${url}/service`)).resolves.toBe(
				"Hello from service worker"
			);
		});

		// TODO: Investigate why this doesn't work on Windows
		it.skipIf(process.platform === "win32")(
			"can fetch service worker c through a (start a, start c)",
			async () => {
				const workerA = helper.runLongLived(cmd, { cwd: a });
				const { url } = await workerA.waitForReady();

				const workerC = helper.runLongLived(cmd, { cwd: c });

				await Promise.all([
					workerC.waitForReady(),
					workerA.readUntil(/- CEE: 🟢/),
				]);
				// Give the dev registry some time to settle
				await setTimeout(500);

				await expect(fetchText(`${url}/service`)).resolves.toBe(
					"Hello from service worker"
				);
			}
		);
	});

	describe("durable objects", () => {
		beforeEach(async () => {
			await baseSeed(a, {
				"wrangler.toml": dedent`
						name = "${workerName}"
						main = "src/index.ts"
						compatibility_date = "2023-01-01"

						[[services]]
						binding = "BEE"
						service = '${workerName2}'

						[durable_objects]
						bindings = [
							{ name = "MY_DO", class_name = "MyDurableObject" }
						]

						[[migrations]]
						tag = "v1"
						new_classes = ["MyDurableObject"]
				`,
			});
		});
		it("can fetch DO through a", async () => {
			const worker = helper.runLongLived(cmd, { cwd: a });

			const { url } = await worker.waitForReady();

			await expect(
				fetchJson(`${url}/do`, {
					headers: {
						"X-Reset-Count": "true",
					},
				})
			).resolves.toMatchObject({ count: 1 });
		});

		it.skipIf(process.platform === "win32")(
			"can fetch remote DO attached to a through b (start b, start a)",
			async () => {
				const workerB = helper.runLongLived(cmd, { cwd: b });
				const { url } = await workerB.waitForReady();

				const workerA = helper.runLongLived(cmd, { cwd: a });

				await Promise.all([
					workerA.waitForReady(),
					workerB.readUntil(/defined in 🟢/),
				]);

				// Give the dev registry some time to settle
				await setTimeout(500);

				await expect(
					fetchJson(`${url}/do`, {
						headers: {
							"X-Reset-Count": "true",
						},
					})
				).resolves.toMatchObject({ count: 1 });
			}
		);

		it("can fetch remote DO attached to a through b (start a, start b)", async () => {
			const workerA = helper.runLongLived(cmd, { cwd: a });
			await workerA.waitForReady();

			const workerB = helper.runLongLived(cmd, { cwd: b });

			const [{ url }] = await Promise.all([
				workerB.waitForReady(),
				workerB.readUntil(/defined in 🟢/),
			]);

			// Give the dev registry some time to settle
			await setTimeout(500);

			await expect(
				fetch(`${url}/do`, {
					headers: {
						"X-Reset-Count": "true",
					},
				}).then((r) => r.json())
			).resolves.toMatchObject({ count: 1 });
		});
	});
});
