import {
	getTRIOSRoleTemplate,
	type TRIOS_ROLE_TEMPLATES,
} from "@trios/shared/constants/role-aware-agents";
import type {
	TRIOSAgentRoleId,
	TRIOSAgentRoleSummary,
	TRIOSCustomRoleInput,
	TRIOSRoleTemplate,
} from "@trios/shared/types/role-aware-agents";

type RoleTemplate = (typeof TRIOS_ROLE_TEMPLATES)[number];
interface BootstrapRenderableRole {
	name: string;
	shortDescription: string;
	longDescription: string;
	recommendedApps: string[];
	boundaries: TRIOSRoleTemplate["boundaries"];
	bootstrap: TRIOSRoleTemplate["bootstrap"];
}

export interface RoleBootstrapFiles {
	"AGENTS.md": string;
	"SOUL.md": string;
	"TOOLS.md": string;
	".trios-role.json": string;
}

export function resolveRoleTemplate(roleId: TRIOSAgentRoleId): RoleTemplate {
	const role = getTRIOSRoleTemplate(roleId);
	if (!role) {
		throw new Error(`Unknown TRIOS role: ${roleId}`);
	}
	return role;
}

export function buildRoleBootstrapFiles(input: {
	role: TRIOSRoleTemplate | TRIOSCustomRoleInput;
	agentName: string;
}): RoleBootstrapFiles {
	const normalizedRole = normalizeRoleForBootstrap(input.role);
	const roleId = "id" in input.role ? input.role.id : undefined;
	return {
		"AGENTS.md": normalizedRole.bootstrap.agentsMd,
		"SOUL.md": normalizedRole.bootstrap.soulMd,
		"TOOLS.md": normalizedRole.bootstrap.toolsMd,
		".trios-role.json": `${JSON.stringify(
			{
				version: 1,
				roleSource: roleId ? "builtin" : "custom",
				roleId,
				roleName: normalizedRole.name,
				shortDescription: normalizedRole.shortDescription,
				createdBy: "trios",
				agentName: input.agentName,
			},
			null,
			2,
		)}\n`,
	};
}

export function toRoleSummary(
	role: TRIOSRoleTemplate | TRIOSCustomRoleInput,
): TRIOSAgentRoleSummary {
	const normalizedRole = normalizeRoleForBootstrap(role);
	return {
		roleSource: "id" in role ? "builtin" : "custom",
		roleId: "id" in role ? role.id : undefined,
		roleName: normalizedRole.name,
		shortDescription: normalizedRole.shortDescription,
	};
}

export function normalizeCustomRole(
	role: TRIOSCustomRoleInput,
): BootstrapRenderableRole {
	const recommendedApps = Array.isArray(role.recommendedApps)
		? role.recommendedApps.filter(
				(app): app is string => typeof app === "string",
			)
		: [];
	const boundaries = Array.isArray(role.boundaries) ? role.boundaries : [];

	return {
		name: role.name,
		shortDescription: role.shortDescription,
		longDescription: role.longDescription,
		recommendedApps,
		boundaries,
		bootstrap: {
			agentsMd:
				role.bootstrap?.agentsMd?.trim() ||
				buildAgentsMd({
					name: role.name,
					longDescription: role.longDescription,
					boundaries,
				}),
			soulMd:
				role.bootstrap?.soulMd?.trim() ||
				buildSoulMd({
					name: role.name,
					shortDescription: role.shortDescription,
					longDescription: role.longDescription,
				}),
			toolsMd:
				role.bootstrap?.toolsMd?.trim() ||
				buildToolsMd({
					boundaries,
					recommendedApps,
				}),
		},
	};
}

function normalizeRoleForBootstrap(
	role: TRIOSRoleTemplate | TRIOSCustomRoleInput,
): BootstrapRenderableRole {
	return "id" in role ? role : normalizeCustomRole(role);
}

function buildAgentsMd(input: {
	name: string;
	longDescription: string;
	boundaries: TRIOSRoleTemplate["boundaries"];
}): string {
	const boundaryLines = input.boundaries
		.map(
			(boundary) =>
				`- ${boundary.label}: ${boundary.description} Default mode: ${boundary.defaultMode}.`,
		)
		.join("\n");

	return `# ${input.name}

You are the ${input.name} specialist for this workspace.

## Core Purpose
${input.longDescription}

## Operating Rules
${boundaryLines}

## Default Output Style
- concise
- action-oriented
- explicit about blockers and approvals
`;
}

function buildSoulMd(input: {
	name: string;
	shortDescription: string;
	longDescription: string;
}): string {
	return `# Operating Style

You act like a trusted ${input.name}.

## Working Posture
- calm
- structured
- direct
- explicit about tradeoffs

## Role Framing
${input.shortDescription}

${input.longDescription}
`;
}

function buildToolsMd(input: {
	boundaries: TRIOSRoleTemplate["boundaries"];
	recommendedApps: string[];
}): string {
	const boundaryLines = input.boundaries
		.map((boundary) => `- ${boundary.label}: ${boundary.defaultMode}`)
		.join("\n");

	const appsLine =
		input.recommendedApps.length > 0
			? input.recommendedApps.join(", ")
			: "No specific apps configured yet.";

	return `# Tooling Guidelines

- Use TRIOS MCP for browser and connected SaaS tasks.
- Prefer read, summarize, and draft flows.
- Keep outputs in the workspace when possible so work remains inspectable.

## Recommended Apps
${appsLine}

## Boundary Defaults
${boundaryLines}
`;
}
