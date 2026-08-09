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
	 * @param internalPatch Patch of internal environment variables. Since we
	 * were blocked, direnv isn't going to provide a patch of the environment
	 * variables the user probably cares about, but it will set some internal
	 * variables to keep track of its own state, which we may want to inspect.
	 */
	constructor(
		public readonly path: string,
		public readonly internalPatch: EnvironmentPatch,
	) {
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
			return parse(stdout)
		} catch (e) {
			if (isStdio(e)) {
				const found = /direnv: error (?<path>.+) is blocked./.exec(e.stderr)
				if (found?.groups?.path) {
					this.blockedPath = found.groups.path
					// .envrc is blocked, let caller ask user what to do
					throw new BlockedError(this.blockedPath, parse(e.stdout, isInternal))
				}
			}
			throw e
		}
	}

	private get workingDirectory(): string {
		return this.cwdOverride ?? cwd()
	}
}

function parse(
	stdout: string,
	predicate: (key: string) => boolean = () => true,
): EnvironmentPatch {
	if (!stdout) return new Map()
	// Null values mean to unset the environment variable
	const record = JSON.parse(stdout) as Record<string, string | null>
	return new Map(
		Object.entries(record)
			.filter(([key]) => predicate(key))
			.map(([key, value]) => [key, value === null ? undefined : value]),
	)
}

export function isInternal(key: string) {
	return key.startsWith('DIRENV_')
}

/**
 * Get the paths direnv is watching for changes.
 *
 * @param patch The environment patch after running direnv. This should include
 * internal environment variables, specifically DIRENV_WATCHES. If absent, or
 * this is undefined, the array of watched paths will be empty.
 * @returns Array of watched paths
 */
export function watchedPaths(patch?: EnvironmentPatch): string[] {
	if (patch === undefined) return []
	const watches: Watch[] = decode(patch.get('DIRENV_WATCHES')) ?? []
	return watches.map((it) => it.path ?? it.Path).filter((it): it is string => !!it)
}

function decode<T>(gzenv?: string | null): T | undefined {
	if (!gzenv) return undefined
	const deflated = Buffer.from(gzenv, 'base64url')
	const inflated = zlib.inflateSync(deflated)
	const json = inflated.toString('utf8')
	return JSON.parse(json) as T
}
