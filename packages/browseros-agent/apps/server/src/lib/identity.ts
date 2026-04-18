/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { Database } from "bun:sqlite";

export interface IdentityConfig {
	installId?: string;
	db: Database;
}

class IdentityService {
	private triosId: string | null = null; // Unique identifier for the TRIOS instance

	initialize(config: IdentityConfig): void {
		const { installId, db } = config;

		// Priority: DB > config > generate new
		this.triosId = this.loadFromDb(db) || installId || this.generateAndSave(db);
	}

	getTRIOSId(): string {
		if (!this.triosId) {
			throw new Error(
				"IdentityService not initialized. Call initialize() first.",
			);
		}
		return this.triosId;
	}

	isInitialized(): boolean {
		return this.triosId !== null;
	}

	private loadFromDb(db: Database): string | null {
		const stmt = db.prepare("SELECT trios_id FROM identity WHERE id = 1");
		const row = stmt.get() as { trios_id: string } | null;
		return row?.trios_id ?? null;
	}

	private generateAndSave(db: Database): string {
		const triosId = crypto.randomUUID();
		const stmt = db.prepare(
			"INSERT OR REPLACE INTO identity (id, trios_id) VALUES (1, ?)",
		);
		stmt.run(triosId);
		return triosId;
	}
}

export const identity = new IdentityService();
