import cp from 'child_process'
import os from 'os'
import { promisify } from 'util'
import vscode from 'vscode'
import zlib from 'zlib'
import config from './config'
import { EnvironmentPatch } from './environment'

const execFile = promisify(cp.execFile)

export class BlockedError extends Error {
	/**
	 *
	 * @param path The path of the blocked .envrc
	 */
	constructor(public readonly path: string) {
		super(`${path} is blocked`)
	}
}

export class CommandNotFoundError extends Error {
	constructor(public readonly path: string) {
		super(`${path}: command not found`)
	}
}

type Watch = {
	path?: string
	['Path']?: string
}

export type Stdio = {
	stdout: string
	stderr: string
}

function isStdio(e: unknown): e is Stdio {
	if (typeof e !== 'object' || e === null) {
		return false
	}
	return 'stdout' in e && 'stderr' in e
}

function isCommandNotFound(e: unknown, path: string): boolean {
	if (!(e instanceof Error)) return false
	if (!('path' in e) || !('code' in e)) return false
	return e.path === path && e.code === 'ENOENT'
}

const echo = {
	['EDITOR']: 'echo',
}

export function cwd(): string {
	return vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? os.homedir()
}

export class DirenvService {
	/**
	 * The path to the .envrc file that was blocked last time we tried to run
	 * direnv. Before we ever run direnv, or when direnv doesn't block the
	 * .envrc file, this is undefined.
	 */
	private blockedPath?: string

	/**
	 * This event fires when direnv gives us a set of paths to watch for
	 * changes. This may fire multiple times, and there is no guarantee that
	 * the set of paths changes each time it fires. The data of the event is the
	 * complete set of paths to watch for.
	 */
	onUpdateWatchedPaths: vscode.EventEmitter<string[]> = new vscode.EventEmitter()

	constructor(
		/**
		 * An optional path to a directory to run direnv in. If not set, we fall
		 * back to {@link cwd}.
		 */
		public cwdOverride?: string | undefined,
	) {}

	public getBlockedPath(): string | undefined {
		return this.blockedPath
	}

	private async direnv(args: string[], env?: NodeJS.ProcessEnv): Promise<Stdio> {
		const options: cp.ExecOptionsWithStringEncoding = {
			encoding: 'utf8',
			cwd: this.workingDirectory,
			env: {
				...process.env,
				['TERM']: 'dumb',
				...env,
				...config.extraEnv.get(),
			},
		}
		const command = config.path.executable.get()
		try {
			return await execFile(command, args, options)
		} catch (e) {
			if (isCommandNotFound(e, command)) {
				throw new CommandNotFoundError(command)
			}
			throw e
		}
	}

	public async test(): Promise<void> {
		await this.direnv(['version'])
	}

	public async allow(path: string): Promise<void> {
		await this.direnv(['allow', path])
	}

	public async block(path: string): Promise<void> {
		await this.direnv(['deny', path])
	}

	public async create(): Promise<string> {
		const { stdout } = await this.direnv(['edit', cwd()], echo)
		return stdout.trimEnd()
	}

	public async find(): Promise<string> {
		try {
			const { stdout } = await this.direnv(['edit'], echo)
			return stdout.trimEnd()
		} catch (e) {
			if (isStdio(e)) {
				const found = /direnv: error (?<path>.+) not found./.exec(e.stderr)
				if (found) {
					// .envrc not found, create a new one
					return this.create()
				}
			}
			throw e
		}
	}

	public async dumpPatch(): Promise<EnvironmentPatch> {
		this.blockedPath = undefined

		try {
			const { stdout } = await this.direnv(['export', 'json'])
			const patch = parse(stdout)
			this.handleNewPatch(patch)
			return patch
		} catch (e) {
			if (isStdio(e)) {
				const found = /direnv: error (?<path>.+) is blocked./.exec(e.stderr)
				if (found?.groups?.path) {
					// .envrc is blocked, let caller ask user what to do
					this.blockedPath = found.groups.path
					this.handleNewPatch(parse(e.stdout))
					throw new BlockedError(this.blockedPath)
				}
			}
			throw e
		}
	}

	private get workingDirectory(): string {
		return this.cwdOverride ?? cwd()
	}

	/**
	 * Update our internal state based on internal environment variables from an
	 * environment patch direnv just put out.
	 * @param patch The patch we just got from direnv
	 */
	private handleNewPatch(patch: EnvironmentPatch): void {
		const watchedPaths = extractWatchedPaths(patch)
		if (watchedPaths !== undefined) {
			this.onUpdateWatchedPaths.fire(watchedPaths)
		}
	}
}

function parse(stdout: string): EnvironmentPatch {
	if (!stdout) return new Map()
	const record = JSON.parse(stdout) as Record<string, string | null>
	return new Map(
		Object.entries(record).map(([key, value]) => [
			key,
			// Null means unset the environment variable
			value === null ? undefined : value,
		]),
	)
}

export function isInternal(key: string) {
	return key.startsWith('DIRENV_')
}

/**
 * Get the paths direnv is watching for changes.
 *
 * @param patch The environment patch after running direnv. This should include
 * internal environment variables, specifically DIRENV_WATCHES. If absent, we
 * return undefined.
 * @returns Array of watched paths, or undefined if we couldn't extract a set of
 * watched paths from the patch.
 */
export function extractWatchedPaths(patch: EnvironmentPatch): string[] | undefined {
	if (!patch.has('DIRENV_WATCHES')) {
		return undefined
	}
	const watches = decode<Watch[]>(patch.get('DIRENV_WATCHES'))
	return watches?.map((it) => it.path ?? it.Path).filter((it): it is string => !!it)
}

function decode<T>(gzenv?: string | null): T | undefined {
	if (!gzenv) return undefined
	const deflated = Buffer.from(gzenv, 'base64url')
	const inflated = zlib.inflateSync(deflated)
	const json = inflated.toString('utf8')
	return JSON.parse(json) as T
}
