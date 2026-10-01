export type AckResult = 'success' | 'version-mismatch'

export type VersionedAckResult<ValueKey extends string> =
    | { result: 'unchanged'; version: number }
    | ({ result: 'success'; version: number } & Record<ValueKey, unknown | null>)
    | ({ result: 'version-mismatch'; version: number } & Record<ValueKey, unknown | null>)
    | { result: 'error'; reason?: string }

export type VersionedAckOptions<TValue, ValueKey extends string> = {
    unchanged?: { version: number; value: unknown; isCurrent: () => boolean }
    valueKey: ValueKey
    parseValue: (value: unknown) => TValue | null
    applyValue: (value: TValue | null) => void
    applyVersion: (version: number) => void
    logInvalidValue: (context: AckResult, version: number) => void
    invalidResponseMessage: string
    errorMessage: string
    versionMismatchMessage: string
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null
}

export const applyVersionedAck = <TValue, ValueKey extends string>(
    ack: unknown,
    options: VersionedAckOptions<TValue, ValueKey>
): void => {
    if (!isRecord(ack)) {
        throw new Error(options.invalidResponseMessage)
    }

    const result = ack.result
    if (result === 'unchanged') {
        if (!options.unchanged || !Number.isSafeInteger(ack.version)
            || ack.version !== options.unchanged.version) {
            throw new Error(options.invalidResponseMessage)
        }
        // Reuse the validated submitted value only if no newer broadcast has
        // arrived. A compact ack does not imply the prior local cache was equal.
        if (!options.unchanged.isCurrent()) return
        return applyVersionedAck({ result: 'success', version: ack.version,
            [options.valueKey]: options.unchanged.value }, options)
    }
    if (result === 'success' || result === 'version-mismatch') {
        const version = ack.version
        if (typeof version !== 'number') {
            throw new Error(options.invalidResponseMessage)
        }

        const rawValue = ack[options.valueKey]
        if (rawValue == null) {
            options.applyValue(null)
        } else {
            const parsed = options.parseValue(rawValue)
            if (parsed === null) {
                options.logInvalidValue(result, version)
            } else {
                options.applyValue(parsed)
            }
        }

        options.applyVersion(version)

        if (result === 'version-mismatch') {
            throw new Error(options.versionMismatchMessage)
        }

        return
    }

    if (result === 'error') {
        const reason = typeof ack.reason === 'string' ? ack.reason : 'unknown'
        throw new Error(`${options.errorMessage} (${reason})`)
    }

    throw new Error(options.invalidResponseMessage)
}
