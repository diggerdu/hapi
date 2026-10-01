import { describe, expect, it } from 'vitest';
import { applyVersionedAck, type AckResult, type VersionedAckOptions } from './versionedUpdate';

type TestState = {
    value: string | null;
    version: number;
};

const baseOptions = (
    state: TestState,
    logInvalids: Array<{ context: AckResult; version: number }>,
    overrides?: Partial<VersionedAckOptions<string, 'metadata'>>
): VersionedAckOptions<string, 'metadata'> => ({
    valueKey: 'metadata',
    parseValue: (value) => (typeof value === 'string' ? value : null),
    applyValue: (value) => {
        state.value = value;
    },
    applyVersion: (version) => {
        state.version = version;
    },
    logInvalidValue: (context, version) => {
        logInvalids.push({ context, version });
    },
    invalidResponseMessage: 'Invalid update-metadata response',
    errorMessage: 'Metadata update failed',
    versionMismatchMessage: 'Metadata version mismatch',
    ...(overrides ?? {})
});

describe('applyVersionedAck', () => {
    it('accepts a negotiated unchanged ack without overwriting a newer cached broadcast', () => {
        const state: TestState = { value: 'newer broadcast', version: 10 };
        applyVersionedAck({ result: 'unchanged', version: 3 }, baseOptions(state, [], {
            unchanged: { version: 3, value: 'submitted', isCurrent: () => state.version === 3 }
        }));
        expect(state).toEqual({ value: 'newer broadcast', version: 10 });
    });

    it('rejects unsolicited, malformed and wrong-version unchanged acknowledgements', () => {
        const state: TestState = { value: 'existing', version: 3 };
        expect(() => applyVersionedAck({ result: 'unchanged', version: 3 }, baseOptions(state, [])))
            .toThrow('Invalid update-metadata response');
        for (const version of [4, '3', NaN, Infinity, 3.5, undefined]) {
            expect(() => applyVersionedAck({ result: 'unchanged', version },
                baseOptions(state, [], { unchanged: { version: 3, value: 'submitted', isCurrent: () => true } })))
                .toThrow('Invalid update-metadata response');
        }
        expect(state).toEqual({ value: 'existing', version: 3 });
    });

    it('validates and applies the submitted value when the local cache is incomplete', () => {
        const state: TestState = { value: null, version: 3 };
        applyVersionedAck({ result: 'unchanged', version: 3 }, baseOptions(state, [], {
            unchanged: { version: 3, value: 'submitted', isCurrent: () => true }
        }));
        expect(state).toEqual({ value: 'submitted', version: 3 });
    });

    it('applies value and version on success', () => {
        const state: TestState = { value: null, version: 0 };
        const logInvalids: Array<{ context: AckResult; version: number }> = [];
        const options = baseOptions(state, logInvalids);

        expect(() => applyVersionedAck({
            result: 'success',
            version: 2,
            metadata: 'next'
        }, options)).not.toThrow();

        expect(state.value).toBe('next');
        expect(state.version).toBe(2);
        expect(logInvalids).toHaveLength(0);
    });

    it('applies value/version then throws on version mismatch', () => {
        const state: TestState = { value: 'old', version: 1 };
        const logInvalids: Array<{ context: AckResult; version: number }> = [];
        const options = baseOptions(state, logInvalids);

        let caught: unknown;
        try {
            applyVersionedAck({
                result: 'version-mismatch',
                version: 5,
                metadata: 'server'
            }, options);
        } catch (error) {
            caught = error;
        }

        if (!(caught instanceof Error)) {
            throw new Error('Expected version mismatch error');
        }

        expect(caught.message).toBe('Metadata version mismatch');
        expect(state.value).toBe('server');
        expect(state.version).toBe(5);
    });

    it('throws on error results without mutating state', () => {
        const state: TestState = { value: 'existing', version: 3 };
        const logInvalids: Array<{ context: AckResult; version: number }> = [];
        const options = baseOptions(state, logInvalids);

        expect(() => applyVersionedAck({
            result: 'error',
            reason: 'access-denied'
        }, options)).toThrow('Metadata update failed (access-denied)');

        expect(state.value).toBe('existing');
        expect(state.version).toBe(3);
    });

    it('throws on malformed responses', () => {
        const state: TestState = { value: 'existing', version: 3 };
        const logInvalids: Array<{ context: AckResult; version: number }> = [];
        const options = baseOptions(state, logInvalids);

        expect(() => applyVersionedAck({
            result: 'success',
            version: 'nope',
            metadata: 'value'
        }, options)).toThrow('Invalid update-metadata response');

        expect(state.value).toBe('existing');
        expect(state.version).toBe(3);
    });

    it('logs invalid values but still updates the version', () => {
        const state: TestState = { value: 'existing', version: 1 };
        const logInvalids: Array<{ context: AckResult; version: number }> = [];
        const options = baseOptions(state, logInvalids, {
            parseValue: () => null
        });

        applyVersionedAck({
            result: 'success',
            version: 4,
            metadata: 123
        }, options);

        expect(state.value).toBe('existing');
        expect(state.version).toBe(4);
        expect(logInvalids).toEqual([{ context: 'success', version: 4 }]);
    });
});
