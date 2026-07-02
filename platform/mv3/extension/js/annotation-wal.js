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

// Annotation (audit) mode — element write-ahead log (pure data layer).
//
// A durable, append-only log of DOM-annotation ("element") records with a
// monotonically increasing sequence number. It exists so that the real-time
// CDP stream (window.__ubolSink, see audit-page.js) has a fallback: anything
// the live stream misses — because the debugger attached late, or a frame was
// torn down before its record streamed — can be replayed from here by sequence
// number and deduplicated by record uid.
//
// The log lives in the background and is mirrored to `chrome.storage.local`
// (NOT session storage), so it survives service-worker restarts AND tab close;
// a reader can drain it after the fact. It is a ring buffer: once it exceeds
// `cap`, the oldest records are dropped (their seq numbers are never reused, so
// a reader can still tell it fell behind). This module has no browser/API
// dependency and is unit-tested in plain Node.

/******************************************************************************/

export class AuditWal {
    constructor({ cap = 20000 } = {}) {
        this.cap = cap > 0 ? cap : 20000;
        this.seq = 0;          // highest sequence number ever assigned
        this.records = [];      // kept sorted by ascending seq
    }

    // Append one record, stamping it with the next sequence number. The record
    // is mutated in place (its `seq` field is set) and also returned.
    append(record) {
        if ( record instanceof Object === false ) { return; }
        this.seq += 1;
        record.seq = this.seq;
        this.records.push(record);
        this.trim();
        return record;
    }

    // Append many; returns the assigned sequence numbers in order.
    appendMany(records) {
        const seqs = [];
        if ( Array.isArray(records) === false ) { return seqs; }
        for ( const record of records ) {
            const r = this.append(record);
            if ( r !== undefined ) { seqs.push(r.seq); }
        }
        return seqs;
    }

    // All records with seq strictly greater than `sinceSeq` (0 => everything
    // still retained). Returns a shallow copy so callers can't mutate the log.
    read(sinceSeq = 0) {
        const since = Number.isFinite(sinceSeq) ? sinceSeq : 0;
        const out = [];
        for ( const rec of this.records ) {
            if ( rec.seq > since ) { out.push(rec); }
        }
        return out;
    }

    // Drop every record with seq <= uptoSeq (a reader acknowledging it has
    // consumed them). `seq` (the assigner) is left untouched so numbering stays
    // monotonic across acks.
    ack(uptoSeq) {
        const upto = Number.isFinite(uptoSeq) ? uptoSeq : 0;
        if ( upto <= 0 ) { return; }
        let w = 0;
        for ( let r = 0; r < this.records.length; r++ ) {
            if ( this.records[r].seq > upto ) {
                this.records[w++] = this.records[r];
            }
        }
        this.records.length = w;
    }

    // Enforce the ring-buffer cap by dropping the oldest records.
    trim() {
        const overflow = this.records.length - this.cap;
        if ( overflow > 0 ) {
            this.records.splice(0, overflow);
        }
    }

    // Lowest seq still retained (0 when empty). A reader whose `sinceSeq` is
    // below this knows it missed records (the log rolled over).
    get oldestSeq() {
        return this.records.length !== 0 ? this.records[0].seq : 0;
    }

    clear() {
        this.records.length = 0;
        this.seq = 0;
    }

    toJSON() {
        return { seq: this.seq, records: this.records };
    }

    static fromJSON(data, opts) {
        const wal = new AuditWal(opts);
        if ( data instanceof Object === false ) { return wal; }
        if ( Array.isArray(data.records) ) {
            wal.records = data.records.slice();
        }
        // Preserve monotonic numbering even if `seq` was absent.
        const lastSeq = wal.records.length !== 0
            ? wal.records[wal.records.length - 1].seq
            : 0;
        wal.seq = Math.max(data.seq || 0, lastSeq || 0);
        wal.trim();
        return wal;
    }
}
