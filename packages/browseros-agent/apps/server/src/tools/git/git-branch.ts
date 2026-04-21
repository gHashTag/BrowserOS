/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 TRIOS
 *
 * Git Branch Tool
 */

import { z } from "zod";
import { defineTool } from "../framework";

export const gitBranch = defineTool({
	name: "git_branch",
	description:
		"List all branches in a git repository or switch to a different branch",
	approvalCategory: "data-modification",
	input: z.object({
		path: z.string().describe("Path to the git repository"),
		action: z.enum(["list", "switch", "create", "delete"]).default("list"),
		branch: z
			.string()
			.optional()
			.describe("Branch name for switch/create/delete actions"),
		baseBranch: z.string().optional().describe("Base branch for create action"),
	}),
	output: z.object({
		success: z.boolean(),
		branches: z
			.array(
				z.object({
					name: z.string(),
					isCurrent: z.boolean(),
					isRemote: z.boolean(),
				}),
			)
			.optional(),
		currentBranch: z.string().optional(),
		error: z.string().optional(),
	}),
	handler: async (args, ctx, response) => {
		const { path, action, branch, baseBranch } = args;
		const { $ } = await import("bun");

		try {
			if (action === "list") {
				const result = await $`git branch -vv`.cwd(path).quiet();
				const lines = result.stdout.toString().split("\n");
				const branches = lines
					.map((line) => {
						const isCurrent = line.startsWith("*");
						const match = line.match(/^\*?\s+(\S+)/);
						if (!match) return null;
						return {
							name: match[1],
							isCurrent,
							isRemote: match[1].startsWith("remotes/"),
						};
					})
					.filter((b): b is NonNullable<typeof b> => b !== null);

				const current = branches.find((b) => b.isCurrent)?.name || "";

				const data = { success: true, branches, currentBranch: current };
				response.text(JSON.stringify(data));
				response.data(data);
			} else if (action === "switch" && branch) {
				await $`git checkout ${branch}`.cwd(path).quiet();
				const data = { success: true, currentBranch: branch };
				response.text(JSON.stringify(data));
				response.data(data);
			} else if (action === "create" && branch) {
				const base = baseBranch || "";
				await $`git checkout -b ${branch} ${base}`.cwd(path).quiet();
				const data = { success: true, currentBranch: branch };
				response.text(JSON.stringify(data));
				response.data(data);
			} else if (action === "delete" && branch) {
				await $`git branch -D ${branch}`.cwd(path).quiet();
				const data = { success: true };
				response.text(JSON.stringify(data));
				response.data(data);
			} else {
				const data = { success: false, error: "Invalid action or missing branch name" };
				response.text(JSON.stringify(data));
				response.data(data);
			}
		} catch (error) {
			const data = { success: false, error: String(error) };
			response.text(JSON.stringify(data));
			response.data(data);
		}
	},
});
