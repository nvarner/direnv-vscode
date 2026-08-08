import vscode from 'vscode'
import { EnvironmentPatch } from './direnv'
import { Checksum } from './checksum'

/**
 * Workspace cache. We get a separate cache per VS Code workspace, and the cache
 * persists between different VS Code sessions in the same workspace.
 */
export class Cache {
	/**
	 * A hash of the environment variables we've changed and their values before
	 * we changed them. We use this to invalidate the environment cache.
	 *
	 * The cache entry has type `string`.
	 */
	private static readonly CHECKSUM_KEY = 'direnv.checksum'

	/**
	 * The cache entry has type {@link EnvironmentPatchCache}.
	 */
	private static readonly ENVIRONMENT_KEY = 'direnv.environment'

	/**
	 * The cache entry has type `string`.
	 */
	private static readonly CWD_OVERRIDE_KEY = 'direnv.cwdOverride'

	/**
	 * Create a cache.
	 *
	 * @param cacheProvider This should be the workspace cache provided by
	 * VS Code, `context.workspaceState`.
	 */
	constructor(private cacheProvider: vscode.Memento) {}

	/**
	 * An optional path to a directory to run direnv in. If not set, we fall
	 * back to a default.
	 */
	public get cwdOverride(): string | undefined {
		return this.cacheProvider.get(Cache.CWD_OVERRIDE_KEY)
	}

	public async setCwdOverride(cwdOverride: string | undefined) {
		await this.cacheProvider.update(Cache.CWD_OVERRIDE_KEY, cwdOverride)
	}

	/**
	 * Environment variables we've changed and their most recent values.
	 */
	public get patch(): EnvironmentPatch | undefined {
		const checksum = this.cacheProvider.get<string>(Cache.CHECKSUM_KEY)
		if (checksum === undefined) return

		const entries = this.cacheProvider.get<EnvironmentPatchCache>(Cache.ENVIRONMENT_KEY)
		if (!Array.isArray(entries)) return

		const patch = new Map(entries)

		const currentEnvironmentHash = new Checksum()
		for (const [key] of patch) {
			currentEnvironmentHash.update(key, process.env[key])
		}
		if (checksum !== currentEnvironmentHash.digest()) return

		return patch
	}

	/**
	 * Set the environment patch by comparing the previous values of environment
	 * variables we've changed against the current environment.
	 *
	 * @param backup An environment patch that undoes the changes we've applied.
	 */
	public async setPatchByDiff(backup: EnvironmentPatch) {
		const previousEnvironmentHash = new Checksum()
		const entries: EnvironmentPatchCache = []
		for (const [key, value] of backup) {
			previousEnvironmentHash.update(key, value)
			entries.push([key, process.env[key]])
		}

		await this.cacheProvider.update(
			Cache.CHECKSUM_KEY,
			previousEnvironmentHash.digest(),
		)
		await this.cacheProvider.update(Cache.ENVIRONMENT_KEY, entries)
	}

	public async clear() {
		await this.cacheProvider.update(Cache.ENVIRONMENT_KEY, undefined)
		await this.cacheProvider.update(Cache.CWD_OVERRIDE_KEY, undefined)
	}
}

/**
 * Like {@link EnvironmentPatch}, but JSON serializable. This is required for
 * values stored in a {@link vscode.Memento}.
 */
type EnvironmentPatchCache = [string, string | undefined][]
