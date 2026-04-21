/**
 * @license AGPL-3.0-or-later
 * Copyright 2025 TRIOS
 *
 * Git Unstage Files Tool
 */

import { z } from "zod";
import { defineTool } from "../framework";

export const gitUnstageFiles = defineTool({
	name: "git_unstage_files",
	description:
		"Unstage specific files from a commit using git stash operations",
	approvalCategory: "data-modification",
	input: z.object({
		paths: z.array(z.string()).describe("Array of file paths to unstage"),
	}),
	output: z.object({
		unstaged: z
			.array(
				z.object({
					path: z.string(),
					status: z.enum(["added", "modified", "deleted", "renamed"]),
					oldPath: z.string().optional(),
				}),
			)
			.describe("Files that were unstaged"),
		stashed_count: z.number().describe("Number of stashed entries"),
	}),
	handler: async (args, ctx, response) => {
		const { paths, stashed_count } = args;
		const { $ } = await import("bun");

		// Import trios_stash from trios-git
		// Note: This requires the trios-server crate to expose the stash tool
		const { stash } = await import("trios-git");
		// @ts-expect-error: Module '"trios-git"' does not exist yet

		try {
			// Get the repo path from paths array
			const repoPath = paths[0];

			// First, perform stash save to preserve current changes
			const saveResult = await stash.stash_save(repoPath);

			// Then unstage the specified files using git stash
			if (paths && paths.length > 0) {
				for (const path of paths) {
					await stash.unstage(repoPath, path);
				}
			}

			// Return stashed files and count
			const result = {
				unstaged: saveResult.unstaged || [],
				stashed_count: stashed_count || 0,
			};
			response.text(JSON.stringify(result));
			response.data(result);
		} catch (error) {
			const errResult = {
				unstaged: [],
				stashed_count: 0,
			};
			response.error(`Failed to unstage files: ${error}`);
			response.data(errResult);
		}
	},
});
