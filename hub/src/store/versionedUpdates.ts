import type { Database } from 'bun:sqlite'
import { isDeepStrictEqual } from 'node:util'

import type { VersionedUpdateResult } from './types'
import { prepareCached } from './statementCache'

type VersionedUpdateArgs<T> = {
    db: Database
    table: string
    id: string
    namespace: string
    field: string
    versionField: string
    expectedVersion: number
    value: T
    encode: (value: T) => string | null
    decode: (value: string | null) => T
    setClauses?: string[]
    params?: Record<string, unknown>
    skipUnchanged?: boolean
}

export function updateVersionedField<T>(args: VersionedUpdateArgs<T>): VersionedUpdateResult<T> {
    try {
        const update = (): VersionedUpdateResult<T> => {
            const readCurrent = () => prepareCached(args.db,
                `SELECT ${args.field} AS field_value, ${args.versionField} AS version
                 FROM ${args.table}
                 WHERE id = ? AND namespace = ?`
            ).get(args.id, args.namespace) as { field_value: string | null; version: number } | undefined

            let encodedValue: string | null
            if (args.skipUnchanged) {
                const current = readCurrent()
                if (!current) return { result: 'error' }
                if (current.version !== args.expectedVersion) {
                    return { result: 'version-mismatch', version: current.version, value: args.decode(current.field_value) }
                }
                encodedValue = args.encode(args.value)
                if (current.field_value === encodedValue) {
                    return { result: 'success', version: current.version, value: args.value }
                }
                const currentValue = args.decode(current.field_value)
                if (isDeepStrictEqual(currentValue, args.value)) {
                    return { result: 'success', version: current.version, value: currentValue }
                }
            } else {
                encodedValue = args.encode(args.value)
            }

            const setClauses = [
                `${args.field} = @field_value`,
                `${args.versionField} = ${args.versionField} + 1`,
                ...(args.setClauses ?? [])
            ]

            const result = prepareCached(args.db,
                `UPDATE ${args.table}
                 SET ${setClauses.join(', ')}
                 WHERE id = @id AND namespace = @namespace AND ${args.versionField} = @expectedVersion`
            ).run({
                id: args.id,
                namespace: args.namespace,
                expectedVersion: args.expectedVersion,
                field_value: encodedValue,
                ...(args.params ?? {})
            })

            if (result.changes === 1) {
                return { result: 'success', version: args.expectedVersion + 1, value: args.value }
            }

            const current = readCurrent()
            if (!current) return { result: 'error' }
            return {
                result: 'version-mismatch',
                version: current.version,
                value: args.decode(current.field_value)
            }
        }
        return args.skipUnchanged ? args.db.transaction(update)() : update()
    } catch {
        return { result: 'error' }
    }
}
