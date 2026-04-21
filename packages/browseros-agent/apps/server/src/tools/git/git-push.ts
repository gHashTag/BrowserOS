/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 TRIOS
 *
 * Git Push Tool
 */

import { z } from "zod";
import { defineTool } from "../framework";

export const gitPush = defineTool({
	name: "git_push",
	description: "Push changes to remote repository",
	approvalCategory: "data-modification",
	input: z.object({
		path: z.string().describe("Path to the git repository"),
		branch: z.string().optional().describe("Specific branch to push"),
		remote: z
			.string()
			.default("origin")
			.describe("Remote name (default: origin)"),
		force: z.boolean().default(false).describe("Force push (use with caution)"),
	}),
	output: z.object({
		success: z.boolean(),
		error: z.string().optional(),
	}),
	handler: async (args, ctx, response) => {
		const { path, branch, remote, force } = args;
		const { $ } = await import("bun");

		try {
			const forceFlag = force ? "--force" : "";

			if (branch) {
				await $`git push ${forceFlag} ${remote} ${branch}`.cwd(path).quiet();
			} else {
				await $`git push ${forceFlag} ${remote}`.cwd(path).quiet();
			}

			const result = { success: true };
			response.text(JSON.stringify(result));
			response.data(result);
		} catch (error) {
			const result = { success: false, error: String(error) };
			response.text(JSON.stringify(result));
			response.data(result);
		}
	},
});
