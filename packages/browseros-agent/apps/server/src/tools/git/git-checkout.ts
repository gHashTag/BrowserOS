/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 TRIOS
 *
 * Git Checkout Tool
 */

import { z } from "zod";
import { defineTool } from "../framework";

export const gitCheckout = defineTool({
	name: "git_checkout",
	description: "Switch branches or restore files in a git repository",
	approvalCategory: "data-modification",
	input: z.object({
		path: z.string().describe("Path to the git repository"),
		target: z.string().describe("Branch name or file path to checkout"),
		restore: z
			.boolean()
			.default(false)
			.describe("If true, restore file from HEAD"),
	}),
	output: z.object({
		success: z.boolean(),
		currentBranch: z.string().optional(),
		error: z.string().optional(),
	}),
	handler: async (args, ctx, response) => {
		const { path, target, restore } = args;
		const { $ } = await import("bun");

		try {
			if (restore) {
				await $`git restore ${target}`.cwd(path).quiet();
				const result = { success: true };
				response.text(JSON.stringify(result));
				response.data(result);
			} else {
				await $`git checkout ${target}`.cwd(path).quiet();

				const branch = await $`git rev-parse --abbrev-ref HEAD`
					.cwd(path)
					.quiet();
				const result = {
					success: true,
					currentBranch: branch.stdout.toString().trim(),
				};
				response.text(JSON.stringify(result));
				response.data(result);
			}
		} catch (error) {
			const result = { success: false, error: String(error) };
			response.text(JSON.stringify(result));
			response.data(result);
		}
	},
});
