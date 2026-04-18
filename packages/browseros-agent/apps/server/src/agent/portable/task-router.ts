/**
 * @license
 * Copyright 2025 TRIOS
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { AgentTask } from "./config-schema";
import type { ErrorCode } from "./errors";

export interface QueuedTask {
	id: string;
	task: AgentTask;
	priority: number;
	submittedAt: number;
	resolve: (result: TaskResult) => void;
	reject: (error: TaskError) => void;
}

export interface TaskResult {
	success: boolean;
	data?: unknown;
	error?: string;
}

export interface TaskError {
	message: string;
	code: ErrorCode;
}

export class TaskRouter {
	private queue: QueuedTask[] = [];
	private processing = false;
	private maxQueueSize: number;

	constructor(maxQueueSize = 100) {
		this.maxQueueSize = maxQueueSize;
	}

	async enqueue(task: AgentTask): Promise<TaskResult> {
		return new Promise((resolve, reject) => {
			if (this.queue.length >= this.maxQueueSize) {
				reject({
					message: "Task queue is full",
					code: "TASK_REJECTED" as ErrorCode,
				});
				return;
			}

			const queued: QueuedTask = {
				id: crypto.randomUUID(),
				task,
				priority: Date.now(),
				submittedAt: Date.now(),
				resolve,
				reject,
			};

			this.queue.push(queued);
			this.processQueue();
		});
	}

	private async processQueue(): Promise<void> {
		if (this.processing || this.queue.length === 0) return;

		this.processing = true;

		while (this.queue.length > 0) {
			const queued = this.queue.shift();
			if (!queued) break;
			try {
				await this.executeTask(queued);
			} catch (error) {
				queued.reject({
					message: error instanceof Error ? error.message : String(error),
					code: "TASK_SEND_FAILED" as ErrorCode,
				});
			}
		}

		this.processing = false;
	}

	private async executeTask(queued: QueuedTask): Promise<void> {
		const result: TaskResult = {
			success: true,
			data: queued.task,
		};
		queued.resolve(result);
	}

	clear(): void {
		for (const task of this.queue) {
			task.reject({
				message: "Task cleared on shutdown",
				code: "TASK_ABORTED" as ErrorCode,
			});
		}
		this.queue = [];
	}

	size(): number {
		return this.queue.length;
	}
}
