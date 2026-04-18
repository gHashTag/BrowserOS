/**
 * @license AGPL-3.0-or-later
 * Ring Registry Stub with TRIOS Integration
 *
 * This is a TEMPORARY workaround for the bootstrap compiler deadlock.
 * TODO: Replace with proper bootstrap compiler state management API once available.
 */

import { readFile, writeFile } from "node:fs/promises";
import * as path from "path";

const RINGS_FILE = "/Users/playra/t27/specs/RINGS.t27";
const TRIOS_SERVER_URL = process.env.TRIOS_MCP_URL || "http://localhost:9005/mcp";

/**
 * Ring status types from RINGS.t27 (static file, not runtime)
 */
type RingStatus = "None" | "InProgress" | "Done" | "Failed" | "Blocked";

interface RingInfo {
    id: string;
    name: string;
    status: RingStatus;
    bootstrapLastSeen: number | null;
    triosServerLastSeen: number | null;
}

/**
 * In-memory cache of ring statuses
 * Combines static data from RINGS.t27 with runtime updates from trios-server
 */
class RingRegistry {
    private rings: Map<string, RingInfo> = new Map();
    private staticData: Map<string, RingInfo> | null = null;

    constructor() {
        this.rings = new Map([
            ["R001", { id: "R001", name: "Core .tri language", status: "Done" }],
            ["R002", { id: "R002", name: "Bootstrap parser", status: "Done" }],
            ["R003", { id: "R003", name: "VM Core + .trib Bytecode Format", status: "Done" }],
            ["R004", { id: "R004", name: "Benchmark layer", status: "Done" }],
            ["R005", { id: "R005", name: "Model DSL", status: "Done" }],
            ["R006", { id: "R006", name: "Search Swarm", status: "Done" }],
            ["R007", { id: "R007", name: "Bootstrap compiler", status: "Done" }],
            ["R008", { id: "R008", name: "Native VSA Ops", status: "NotStarted" }],
        ]);
    }

    /**
     * Initialize the registry by reading RINGS.t27
     */
    async init(): Promise<void> {
        try {
            const content = await readFile(RINGS_FILE, "utf-8");
            this.staticData = this.parseRINGS(content);
            console.log(`[RingRegistry] Initialized with ${this.rings.size} rings`);
        } catch (error) {
            console.error(`[RingRegistry] Failed to initialize: ${error.message}`);
            this.staticData = new Map([
                ["R001", { id: "R001", name: "Core .tri language", status: "Done" }],
                ["R002", { id: "R002", name: "Bootstrap parser", status: "Done" }],
                // ... minimal set for basic operation
            ]);
        }
    }

    /**
     * Parse RINGS.t27 content
     */
    private parseRINGS(content: string): Map<string, RingInfo> {
        const rings = new Map<string, RingInfo>();
        let currentRingId: string | null = null;

        for (const line of content.split("\n")) {
            line = line.trim();
            if (!line) continue;

            // Match ring declarations
            const ringMatch = line.match(/^ring\s+"([^"]+)":/);
            if (ringMatch) {
                const ringId = ringMatch[1];
                const ringDef = line.slice(ringMatch[0].length).trim();

                // Parse ring status and rings
                const ringInfo: RingInfo = {
                    id: ringId,
                    name: ringId,
                    status: this.parseRingStatus(ringDef),
                    bootstrapLastSeen: null,
                    triosServerLastSeen: null,
                };

                // Parse associated rings
                const ringsMatch = ringDef.match(/rings\s*=\[([^\]]+)\]/);
                if (ringsMatch) {
                    const associatedIds = ringsMatch[1].split(",").map(id => id.trim());
                    rings.set(ringId, ringInfo);

                    for (const ringId of associatedIds) {
                        if (!this.rings.has(ringId)) {
                            this.rings.set(ringId, {
                                id: ringId,
                                name: ringId,
                                status: "None",
                                bootstrapLastSeen: null,
                                triosServerLastSeen: null,
                            });
                        }
                    }
                }

                currentRingId = ringId;
            }

        return rings;
    }

    /**
     * Parse ring status from ring definition
     */
    private parseRingStatus(ringDef: string): RingStatus {
        const statusMatch = ringDef.match(/status\s*=\[([^\]]+)\]/);
        if (statusMatch) {
            const status = statusMatch[1].trim();
            if (status === "InProgress") return "InProgress";
            if (status === "Done") return "Done";
            if (status === "Failed") return "Failed";
            if (status === "Blocked") return "Blocked";
        }
        return "None";
    }

    /**
     * Get ring info by ID
     */
    getRingInfo(ringId: string): RingInfo | undefined {
        return this.rings.get(ringId);
    }

    /**
     * Get all rings with their status
     */
    getAllRings(): Map<string, RingInfo> {
        return this.rings;
    }

    /**
     * Get ring status including TRIOS server state
     * @param ringId - Ring ID to check
     * @returns Status including whether trios-server was last seen
     */
    async getRingStatus(ringId: string, triosServerStatus: "Connected" | "Disconnected" = "Unknown"): Promise<{
        ringStatus: RingStatus;
        triosServerStatus: "Connected" | "Disconnected";
    }> {
        const ringInfo = this.getRingInfo(ringId);
        if (!ringInfo) {
            return {
                ringStatus: "None",
                triosServerStatus: "Unknown",
            };
        }

        // Return ring status from RINGS.t27
        let ringStatus = ringInfo.status;

        // If trios-server was last seen, update triosServer status
        if (triosServerStatus === "Connected") {
            ringInfo.triosServerLastSeen = Date.now();
        }

        // Combine statuses for decision making
        // If trios-server is disconnected but ring is InProgress or Done → assume InProgress
        if (triosServerStatus === "Disconnected" && (ringStatus === "InProgress" || ringStatus === "Done")) {
            // TRIOS server down but ring says it's done → assume still working
            ringInfo.triosServerLastSeen = Date.now();
        }

        return {
            ringStatus: this.mapRingStatus(ringStatus),
            triosServerStatus,
        };
    }

    /**
     * Set ring to InProgress (via RINGS.t27 file write)
     * @param ringId - Ring ID to set to InProgress
     */
    async setRingInProgress(ringId: string): Promise<boolean> {
        const ringInfo = this.getRingInfo(ringId);
        if (!ringInfo) {
            console.error(`[RingRegistry] Ring ${ringId} not found`);
            return false;
        }

        // Update static data (temporary workaround until proper API)
        ringInfo.status = "InProgress";
        this.rings.set(ringId, ringInfo);

        // Write to RINGS.t27 (in-place update for runtime state)
        try {
            let content = await readFile(RINGS_FILE, "utf-8");
            const lines = content.split("\n");

            // Find the ring declaration and update it
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                const ringMatch = line.match(new RegExp(`^ring\\s+"${ringId}":/`));
                if (ringMatch) {
                    // Found the ring declaration, now find status line
                    let statusLine = -1;
                    for (let j = i + 1; j < lines.length; j++) {
                        const statusMatch = lines[j].match(new RegExp(`^ring\\s+"${ringId}":\\s*status\\s*=\[([^\]]+)\]`));
                        if (statusMatch) {
                            statusLine = j;
                            break;
                        }
                    }

                    if (statusLine > -1) {
                        // Update status in place
                        const oldStatus = lines[statusLine].match(/status\s*=\[([^\]]+)\]/);
                        lines[statusLine] = lines[statusLine].replace(oldStatus[1], `status=["InProgress"]`);
                        console.log(`[RingRegistry] Set R${ringId} to InProgress in RINGS.t27`);
                    }

                    break;
                }
            }

            await writeFile(RINGS_FILE, lines.join("\n"), "utf-8");
            console.log(`[RingRegistry] Successfully set R${ringId} to InProgress`);
            return true;
        } catch (error) {
            console.error(`[RingRegistry] Failed to set ring status: ${error.message}`);
            return false;
        }
    }

    /**
     * Set ring to Done (via RINGS.t27 file write)
     * @param ringId - Ring ID to set to Done
     */
    async setRingDone(ringId: string): Promise<boolean> {
        const ringInfo = this.getRingInfo(ringId);
        if (!ringInfo) {
            console.error(`[RingRegistry] Ring ${ringId} not found`);
            return false;
        }

        // Update static data
        ringInfo.status = "Done";
        ringInfo.bootstrapLastSeen = null;
        ringInfo.triosServerLastSeen = null;
        this.rings.set(ringId, ringInfo);

        // Write to RINGS.t27
        try {
            let content = await readFile(RINGS_FILE, "utf-8");
            const lines = content.split("\n");

            // Find the ring declaration and update it
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                const ringMatch = line.match(new RegExp(`^ring\\s+"${ringId}":/`));
                if (ringMatch) {
                    // Found the ring declaration, now find status line
                    let statusLine = -1;
                    for (let j = i + 1; j < lines.length; j++) {
                        const statusMatch = lines[j].match(new RegExp(`^ring\\s+"${ringId}":\\s*status\\s*=\[([^\]]+)\]`));
                        if (statusMatch) {
                            statusLine = j;
                            break;
                        }
                    }

                    if (statusLine > -1) {
                        // Update status in place
                        const oldStatus = lines[statusLine].match(/status\s*=\[([^\]]+)\]/);
                        lines[statusLine] = lines[statusLine].replace(oldStatus[1], `status=["Done"]`);
                        console.log(`[RingRegistry] Set R${ringId} to Done in RINGS.t27`);
                    }

                    break;
                }
            }

            await writeFile(RINGS_FILE, lines.join("\n"), "utf-8");
            console.log(`[RingRegistry] Successfully set R${ringId} to Done in RINGS.t27`);
            return true;
        } catch (error) {
            console.error(`[RingRegistry] Failed to set ring status: ${error.message}`);
            return false;
        }
    }

    /**
     * Get the number of active rings (rings that are not None or Blocked)
     */
    getActiveRingCount(): number {
        return Array.from(this.rings.values()).filter(
            r => r.status !== "None" && r.status !== "Blocked"
        ).length;
    }

    /**
     * Clear in-memory cache and reload from RINGS.t27
     */
    async reload(): Promise<void> {
        this.staticData = null;
        await this.init();
    }
}

/**
 * Singleton instance
 */
let ringRegistry: RingRegistry | null = null;

/**
 * Get the ring registry singleton
 */
export function getRingRegistry(): RingRegistry {
    if (!ringRegistry) {
        ringRegistry = new RingRegistry();
    }
    return ringRegistry;
}

/**
 * Get ring status with TRIOS server awareness
 * Wrapper that handles TRIOS server connectivity checking
 */
export async function getRingStatusWithTRIOS(
    ringId: string,
    triosServerStatus: "Connected" | "Disconnected" = "Unknown" = "Unknown"
): Promise<{
        ringStatus: RingStatus;
        triosServerStatus: "Connected" | "Disconnected";
    }> {
    const registry = getRingRegistry();

    // If triosServerStatus is "Unknown", check if it's actually connected
    if (triosServerStatus === "Unknown") {
        try {
            // Try to call a tool on trios-server to verify connectivity
            const response = await fetch(`${TRIOS_SERVER_URL}/tools/list`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "tools/list",
                }),
            });

            if (response.ok) {
                const data = await response.json();
                triosServerStatus = data.tools && data.tools.length > 0 ? "Connected" : "Disconnected";
                console.log(`[RingRegistry] TRIOS server status: ${triosServerStatus}`);
            } else {
                triosServerStatus = "Disconnected";
                console.log(`[RingRegistry] TRIOS server not responding`);
            }
        } catch (error) {
            triosServerStatus = "Disconnected";
            console.log(`[RingRegistry] Failed to check TRIOS server: ${error.message}`);
        }
    }

    // Get ring status with updated triosServer status
    const result = await registry.getRingStatus(ringId, triosServerStatus);

    return {
        ringStatus: result.ringStatus,
        triosServerStatus: result.triosServerStatus,
    };
}

/**
 * Set ring to InProgress before trios-server operations
 * This is the CRITICAL function that fixes the bootstrap compiler deadlock
 */
export async function setRingInProgressBeforeTRIOS(ringId: string): Promise<boolean> {
    const registry = getRingRegistry();

    const ringInfo = registry.getRingInfo(ringId);
    if (!ringInfo) {
        console.error(`[RingRegistry] Ring ${ringId} not found`);
        return false;
    }

    // Update static data and write to RINGS.t27
    ringInfo.status = "InProgress";
    ringInfo.triosServerLastSeen = Date.now();
    registry.rings.set(ringId, ringInfo);

    try {
        let content = await readFile(RINGS_FILE, "utf-8");
        const lines = content.split("\n");

        // Find the ring declaration and update it
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            const ringMatch = line.match(new RegExp(`^ring\\s+"${ringId}":/`));
            if (ringMatch) {
                // Found the ring declaration, now find status line
                let statusLine = -1;
                for (let j = i + 1; j < lines.length; j++) {
                    const statusMatch = lines[j].match(new RegExp(`^ring\\s+"${ringId}":\\s*status\\s*=\[([^\]]+)\]`));
                    if (statusMatch) {
                            statusLine = j;
                            break;
                        }
                    }

                if (statusLine > -1) {
                    // Update status in place
                    const oldStatus = lines[statusLine].match(/status\s*=\[([^\]]+)\]/);
                    lines[statusLine] = lines[statusLine].replace(oldStatus[1], `status=["InProgress"]`);
                    console.log(`[RingRegistry] Set R${ringId} to InProgress in RINGS.t27`);
                }

                break;
            }
        }

        await writeFile(RINGS_FILE, lines.join("\n"), "utf-8");
        console.log(`[RingRegistry] Successfully set R${ringId} to InProgress before TRIOS operations`);
        return true;
    } catch (error) {
        console.error(`[RingRegistry] Failed to set ring status: ${error.message}`);
        return false;
    }
}

/**
 * Get the number of active rings (trios-aware version)
 */
export function getActiveRingCountWithTRIOS(): Promise<number> {
    const registry = getRingRegistry();
    const ringInfo = registry.getRingInfo("R007");

    // Check if trios-server is connected
    let triosConnected = false;
    try {
        const response = await fetch(`${TRIOS_SERVER_URL}/tools/list`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/list",
            }),
        });

        if (response.ok) {
            const data = await response.json();
            triosConnected = data.tools && data.tools.length > 0;
        }
    } catch (error) {
        console.log(`[RingRegistry] Failed to check TRIOS server: ${error.message}`);
    }

    const count = ringInfo ? (ringInfo.status !== "None" && ringInfo.status !== "Blocked" && (triosConnected ? 1 : 0) : 0;
    return count;
}
