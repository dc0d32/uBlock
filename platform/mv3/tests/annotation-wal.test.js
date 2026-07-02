/*******************************************************************************

    uBlock Origin Lite - a comprehensive, MV3-compliant content blocker
    Copyright (C) 2025-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

// Unit tests for the pure element write-ahead log used by annotation (audit)
// mode. Run with:  node --test platform/mv3/tests/

import { describe, it } from 'node:test';
import { AuditWal } from '../extension/js/annotation-wal.js';
import { strict as assert } from 'node:assert';
/******************************************************************************/

describe('AuditWal.append', () => {
    it('assigns strictly increasing sequence numbers', () => {
        const wal = new AuditWal();
        const a = wal.append({ uid: 'a' });
        const b = wal.append({ uid: 'b' });
        const c = wal.append({ uid: 'c' });
        assert.equal(a.seq, 1);
        assert.equal(b.seq, 2);
        assert.equal(c.seq, 3);
        assert.equal(wal.seq, 3);
    });
    it('ignores non-object records', () => {
        const wal = new AuditWal();
        assert.equal(wal.append(null), undefined);
        assert.equal(wal.append(42), undefined);
        assert.equal(wal.seq, 0);
    });
    it('appendMany returns the assigned seqs', () => {
        const wal = new AuditWal();
        const seqs = wal.appendMany([ { uid: 'a' }, { uid: 'b' } ]);
        assert.deepEqual(seqs, [ 1, 2 ]);
    });
});

describe('AuditWal.read', () => {
    it('returns everything above sinceSeq', () => {
        const wal = new AuditWal();
        wal.appendMany([ { uid: 'a' }, { uid: 'b' }, { uid: 'c' } ]);
        assert.deepEqual(wal.read(0).map(r => r.uid), [ 'a', 'b', 'c' ]);
        assert.deepEqual(wal.read(1).map(r => r.uid), [ 'b', 'c' ]);
        assert.deepEqual(wal.read(3).map(r => r.uid), []);
    });
    it('returns a copy that cannot mutate the log', () => {
        const wal = new AuditWal();
        wal.append({ uid: 'a' });
        const out = wal.read(0);
        out.push({ uid: 'x' });
        assert.equal(wal.records.length, 1);
    });
});

describe('AuditWal.ack', () => {
    it('drops records up to and including uptoSeq but keeps numbering', () => {
        const wal = new AuditWal();
        wal.appendMany([ { uid: 'a' }, { uid: 'b' }, { uid: 'c' } ]);
        wal.ack(2);
        assert.deepEqual(wal.read(0).map(r => r.uid), [ 'c' ]);
        // Numbering continues monotonically after an ack.
        const d = wal.append({ uid: 'd' });
        assert.equal(d.seq, 4);
    });
    it('ignores non-positive ack values', () => {
        const wal = new AuditWal();
        wal.appendMany([ { uid: 'a' } ]);
        wal.ack(0);
        wal.ack(-5);
        assert.equal(wal.records.length, 1);
    });
});

describe('AuditWal ring buffer', () => {
    it('drops oldest records past the cap but keeps seq monotonic', () => {
        const wal = new AuditWal({ cap: 3 });
        wal.appendMany([ { uid: 'a' }, { uid: 'b' }, { uid: 'c' }, { uid: 'd' } ]);
        assert.deepEqual(wal.records.map(r => r.uid), [ 'b', 'c', 'd' ]);
        assert.equal(wal.seq, 4);
        assert.equal(wal.oldestSeq, 2);
    });
    it('a reader below oldestSeq can detect it fell behind', () => {
        const wal = new AuditWal({ cap: 2 });
        wal.appendMany([ { uid: 'a' }, { uid: 'b' }, { uid: 'c' } ]);
        // 'a' (seq 1) was dropped; a reader asking since 0 sees oldestSeq=2>1.
        assert.ok(wal.oldestSeq > 1);
        assert.deepEqual(wal.read(0).map(r => r.uid), [ 'b', 'c' ]);
    });
});

describe('AuditWal serialization', () => {
    it('round-trips through toJSON/fromJSON', () => {
        const wal = new AuditWal({ cap: 10 });
        wal.appendMany([ { uid: 'a' }, { uid: 'b' } ]);
        const restored = AuditWal.fromJSON(JSON.parse(JSON.stringify(wal.toJSON())), { cap: 10 });
        assert.equal(restored.seq, 2);
        assert.deepEqual(restored.read(0).map(r => r.uid), [ 'a', 'b' ]);
        assert.equal(restored.append({ uid: 'c' }).seq, 3);
    });
    it('recovers seq from records when absent', () => {
        const restored = AuditWal.fromJSON({ records: [ { uid: 'a', seq: 5 } ] });
        assert.equal(restored.seq, 5);
        assert.equal(restored.append({ uid: 'b' }).seq, 6);
    });
    it('fromJSON on garbage yields an empty log', () => {
        assert.equal(AuditWal.fromJSON(null).seq, 0);
        assert.equal(AuditWal.fromJSON(undefined).read(0).length, 0);
    });
});
