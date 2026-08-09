import vscode from 'vscode'

/**
 * The name of an environment variable.
 */
export type Variable = string

/**
 * A string is the value of an environment variable, and undefined means the
 * variable is unset.
 */
export type Value = string | undefined

/**
 * A patch that can update an environment. Variables in an environment that are
 * not included in the patch are unchanged. This is like
 * {@link EnvironmentDiff}, except that a patch doesn't care about the old value
 * of variables it's changing.
 */
export type EnvironmentPatch = Map<Variable, Value>

/**
 * A diff showing an old and new value of a variable.
 */
export type ValueDiff = {
	oldValue: Value
	newValue: Value
}

/**
 * A diff between environments. This is like {@link EnvironmentPatch}, except
 * that a diff knows the old value of variables it's changing.
 */
export type EnvironmentDiff = Map<Variable, ValueDiff>

/**
 * Turn a diff from environment A to environment B into a patch from environment
 * A to environment B
 */
function diffToPatch(diff: EnvironmentDiff): EnvironmentPatch {
	return new Map(
		[...diff.entries()].map(([variable, { newValue }]) => [variable, newValue]),
	)
}

/**
 * Turn a diff from environment A to environment B into a patch from environment
 * B to environment A
 */
function diffToReversePatch(diff: EnvironmentDiff): EnvironmentPatch {
	return new Map(
		[...diff.entries()].map(([variable, { oldValue }]) => [variable, oldValue]),
	)
}

export class EnvironmentService {
	private appliedChanges: EnvironmentDiff = new Map()

	constructor(
		private processEnvironment: NodeJS.ProcessEnv,
		private terminalEnvironment: vscode.EnvironmentVariableCollection,
	) {}

	applyPatch(patch: EnvironmentPatch): void {
		this.patchAppliedChanges(patch)
		this.patchProcessEnvironment(patch)
		this.patchTerminalEnvironment(patch)
	}

	reset(): void {
		this.patchProcessEnvironment(diffToReversePatch(this.appliedChanges))
		this.terminalEnvironment.clear()
		this.appliedChanges.clear()
	}

	getAppliedChanges(): EnvironmentDiff {
		return this.appliedChanges
	}

	/**
	 * Try to set the applied changes to a particular diff. This may fail if the
	 * chosen diff is incompatible with the actual environment.
	 * @param diff The diff to set as the applied changes
	 */
	trySetAppliedChanges(diff: EnvironmentDiff) {
		if (!this.isDiffCompatible(diff)) {
			return
		}

		this.reset()

		const patch = diffToPatch(diff)
		this.appliedChanges = diff
		this.patchProcessEnvironment(patch)
		this.patchTerminalEnvironment(patch)
	}

	/**
	 * Apply a patch on top of {@link appliedChanges}. For variables which are
	 * newly modified, we pull the old value from {@link processEnvironment}.
	 * @param patch Patch to apply to {@link appliedChanges}
	 */
	private patchAppliedChanges(patch: EnvironmentPatch): void {
		for (const [variable, newValue] of patch) {
			const valueDiff = this.appliedChanges.get(variable)
			if (!valueDiff) {
				const oldValue = this.processEnvironment[variable]
				this.appliedChanges.set(variable, { oldValue, newValue })
			} else {
				valueDiff.newValue = newValue
			}
		}
	}

	private patchProcessEnvironment(patch: EnvironmentPatch): void {
		for (const [variable, value] of patch) {
			if (value === undefined) {
				// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
				delete this.processEnvironment[variable]
			} else {
				this.processEnvironment[variable] = value
			}
		}
	}

	private patchTerminalEnvironment(patch: EnvironmentPatch): void {
		for (const [variable, value] of patch) {
			if (value === undefined && this.getUnchanged(variable) === undefined) {
				this.terminalEnvironment.delete(variable)
			} else {
				// can't unset, set to empty instead
				this.terminalEnvironment.replace(variable, value ?? '', {
					applyAtProcessCreation: true,
					applyAtShellIntegration: true,
				})
			}
		}
	}

	/**
	 * Is it possible that this diff is from the unchanged environment to
	 * another environment? Specifically, do the old values in the diff match
	 * the unchanged values of this environment?
	 * @param diff Diff to check compatibility for
	 */
	private isDiffCompatible(diff: EnvironmentDiff): boolean {
		return [...diff].every(
			([variable, { oldValue }]) => oldValue === this.getUnchanged(variable),
		)
	}

	/**
	 * Get the last value of a variable before we applied a change to it.
	 * @param variable The variable to get the unchanged value of.
	 * @returns If the variable was changed, the value of the variable
	 * immediately before we changed it. Otherwise, the current value of the
	 * variable.
	 */
	private getUnchanged(variable: Variable): Value {
		const appliedChange = this.appliedChanges.get(variable)
		if (appliedChange) {
			return appliedChange.oldValue
		} else {
			return this.processEnvironment[variable]
		}
	}
}
