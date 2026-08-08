import cp from 'child_process'
import os from 'os'
import { promisify } from 'util'
import vscode from 'vscode'
import zlib from 'zlib'
import config from './config'

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

/**
 * A patch that turns an old environment to a new one.
 *
 * The keys in the map are the environment variables that differ between the two
 * environments. The value for a key is the value of the variable in the new
 * environment. An undefined value means the variable should be unset.
 */
export type EnvironmentPatch = Map<string, string | undefined>

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

async function direnv(
	args: string[],
	env?: NodeJS.ProcessEnv,
	cwdOverride?: string,
): Promise<Stdio> {
	const options: cp.ExecOptionsWithStringEncoding = {
		encoding: 'utf8',
		cwd: cwdOverride ?? cwd(),
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

export async function test(): Promise<void> {
	await direnv(['version'])
}

export async function allow(path: string): Promise<void> {
	await direnv(['allow', path])
}

export async function block(path: string): Promise<void> {
	await direnv(['deny', path])
}

export async function create(): Promise<string> {
	const { stdout } = await direnv(['edit', cwd()], echo)
	return stdout.trimEnd()
}

export async function find(): Promise<string> {
	try {
		const { stdout } = await direnv(['edit'], echo)
		return stdout.trimEnd()
	} catch (e) {
		if (isStdio(e)) {
			const found = /direnv: error (?<path>.+) not found./.exec(e.stderr)
			if (found) {
				// .envrc not found, create a new one
				return create()
			}
		}
		throw e
	}
}

export async function dumpPatch(cwdOverride?: string): Promise<EnvironmentPatch> {
	try {
		const { stdout } = await direnv(['export', 'json'], undefined, cwdOverride)
		return parse(stdout)
	} catch (e) {
		if (isStdio(e)) {
			const found = /direnv: error (?<path>.+) is blocked./.exec(e.stderr)
			if (found?.groups?.path) {
				// .envrc is blocked, let caller ask user what to do
				throw new BlockedError(found.groups.path, parse(e.stdout, isInternal))
			}
		}
		throw e
	}
}

function parse(
	stdout: string,
	predicate: (key: string) => boolean = () => true,
): EnvironmentPatch {
	if (!stdout) return new Map()
	const record = JSON.parse(stdout) as Record<string, string>
	return new Map(Object.entries(record).filter(([key]) => predicate(key)))
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
