import {
	OPENCLAW_CONTAINER_HOME,
	OPENCLAW_TERMINAL_SHELL,
} from "@trios/shared/constants/openclaw";
import { logger } from "../../../lib/logger";

export const TERMINAL_HOME_DIR = OPENCLAW_CONTAINER_HOME;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const TERMINAL_NAME = "xterm-256color";

interface TerminalSessionDeps {
	containerName: string;
	podmanPath: string;
	workingDir: string;
	onExit: (exitCode: number) => void;
	onOutput: (data: string) => void;
}

export interface TerminalSession {
	close(): void;
	resize(cols: number, rows: number): void;
	writeInput(data: string): void;
}

export function buildTerminalExecCommand(
	podmanPath: string,
	containerName: string,
	workingDir: string,
): string[] {
	return [
		podmanPath,
		"exec",
		"-it",
		"-w",
		workingDir,
		containerName,
		OPENCLAW_TERMINAL_SHELL,
	];
}

export function createTerminalSession(
	deps: TerminalSessionDeps,
): TerminalSession {
	const decoder = new TextDecoder();
	const proc = Bun.spawn(
		buildTerminalExecCommand(
			deps.podmanPath,
			deps.containerName,
			deps.workingDir,
		),
		{
			terminal: {
				cols: DEFAULT_COLS,
				rows: DEFAULT_ROWS,
				data(_terminal, data) {
					const chunk = decoder.decode(data, { stream: true });
					if (chunk) deps.onOutput(chunk);
				},
			},
			env: { ...process.env, TERM: TERMINAL_NAME },
		},
	);
	let closed = false;

	void proc.exited.then((exitCode) => {
		const trailing = decoder.decode();
		if (trailing) deps.onOutput(trailing);
		deps.onExit(exitCode);
	});

	logger.debug("Terminal session created", { workingDir: deps.workingDir });

	return {
		writeInput(data) {
			proc.terminal?.write(data);
		},
		resize(cols, rows) {
			proc.terminal?.resize(cols, rows);
		},
		close() {
			if (closed) return;
			closed = true;
			try {
				proc.terminal?.close();
				proc.kill();
			} catch {
				logger.debug("Terminal session cleanup failed");
			}
			logger.debug("Terminal session destroyed");
		},
	};
}
