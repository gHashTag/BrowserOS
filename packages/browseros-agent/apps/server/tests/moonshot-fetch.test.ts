import { describe, expect, it, mock } from "bun:test";
import { createMoonshotFetch } from "../src/lib/clients/llm/moonshot-fetch";

describe("createMoonshotFetch", () => {
	const createMockFetch = () => {
		return mock((input: RequestInfo | URL, init?: RequestInit) => {
			return Promise.resolve(
				new Response(JSON.stringify({ ok: true }), { status: 200 }),
			);
		});
	};

	it("removes parallel_tool_calls", async () => {
		const mockFetch = createMockFetch();
		globalThis.fetch = mockFetch;

		const moonshotFetch = createMoonshotFetch();
		await moonshotFetch("https://api.moonshot.ai/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({
				model: "kimi-k2.5",
				messages: [],
				parallel_tool_calls: true,
			}),
		});

		const callBody = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
		expect(callBody.parallel_tool_calls).toBeUndefined();
	});

	it("removes response_format with json_schema without name", async () => {
		const mockFetch = createMockFetch();
		globalThis.fetch = mockFetch;

		const moonshotFetch = createMoonshotFetch();
		await moonshotFetch("https://api.moonshot.ai/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({
				model: "kimi-k2.5",
				messages: [],
				response_format: { type: "json_schema", json_schema: {} },
			}),
		});

		const callBody = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
		expect(callBody.response_format).toBeUndefined();
	});

	it("removes strict flag from response_format", async () => {
		const mockFetch = createMockFetch();
		globalThis.fetch = mockFetch;

		const moonshotFetch = createMoonshotFetch();
		await moonshotFetch("https://api.moonshot.ai/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({
				model: "kimi-k2.5",
				messages: [],
				response_format: {
					type: "json_schema",
					json_schema: { name: "test" },
					strict: true,
				},
			}),
		});

		const callBody = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
		expect(callBody.response_format.strict).toBeUndefined();
		expect(callBody.response_format.type).toBe("json_schema");
	});

	it("removes max_tokens when 0", async () => {
		const mockFetch = createMockFetch();
		globalThis.fetch = mockFetch;

		const moonshotFetch = createMoonshotFetch();
		await moonshotFetch("https://api.moonshot.ai/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({
				model: "kimi-k2.5",
				messages: [],
				max_tokens: 0,
			}),
		});

		const callBody = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
		expect(callBody.max_tokens).toBeUndefined();
	});

	it("clamps max_tokens to 32768 when > 98304", async () => {
		const mockFetch = createMockFetch();
		globalThis.fetch = mockFetch;

		const moonshotFetch = createMoonshotFetch();
		await moonshotFetch("https://api.moonshot.ai/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({
				model: "kimi-k2.5",
				messages: [],
				max_tokens: 100000,
			}),
		});

		const callBody = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
		expect(callBody.max_tokens).toBe(32768);
	});

	it("sets frequency_penalty and presence_penalty to 0", async () => {
		const mockFetch = createMockFetch();
		globalThis.fetch = mockFetch;

		const moonshotFetch = createMoonshotFetch();
		await moonshotFetch("https://api.moonshot.ai/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({
				model: "kimi-k2.5",
				messages: [],
				frequency_penalty: 0.5,
				presence_penalty: -0.3,
			}),
		});

		const callBody = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
		expect(callBody.frequency_penalty).toBe(0);
		expect(callBody.presence_penalty).toBe(0);
	});
});
