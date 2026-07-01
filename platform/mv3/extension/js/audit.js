/*******************************************************************************

    uBlock Origin Lite - a comprehensive, MV3-compliant content blocker
    Copyright (C) 2014-present Raymond Hill

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

import { dom, qs$ } from './dom.js';
import { sendMessage } from './ext.js';

/******************************************************************************/

const url = new URL(document.location.href);
const tabId = parseInt(url.searchParams.get('tab'), 10) || 0;

/******************************************************************************/

const renderRecord = (record, template) => {
    const row = template.content.cloneNode(true);
    const container = qs$(row, '.record');

    const verdict = record.verdict === 'derived' ? 'derived' : 'direct';
    dom.cl.add(container, verdict);
    dom.text(qs$(container, '.verdict'), verdict);
    dom.text(qs$(container, '.source'), record.source || '');
    dom.text(qs$(container, '.type'), record.type || '');

    dom.text(qs$(container, '.url .value'), record.url || '');

    if ( record.initiator ) {
        dom.text(qs$(container, '.initiator .value'), record.initiator);
    } else {
        dom.cl.add(qs$(container, '.initiator'), 'hidden');
    }

    if ( record.matchedRule ) {
        const { rulesetId, ruleId } = record.matchedRule;
        dom.text(qs$(container, '.matchedRule .value'), `${rulesetId} / ${ruleId}`);
    } else {
        dom.cl.add(qs$(container, '.matchedRule'), 'hidden');
    }

    const chain = qs$(container, '.chain');
    if ( Array.isArray(record.initiatorChain) && record.initiatorChain.length !== 0 ) {
        for ( const frame of record.initiatorChain ) {
            const line = dom.create('span');
            dom.cl.add(line, 'frame');
            dom.text(line, frame);
            chain.append(line);
        }
    } else {
        dom.cl.add(chain, 'hidden');
    }

    return row;
};

/******************************************************************************/

const render = async ( ) => {
    const data = await sendMessage({ what: 'getAuditData', tabId });
    const requests = (data && Array.isArray(data.requests)) ? data.requests : [];

    // Group by document, then order by capture time so the audit trail reads
    // in the same order the resources were seen.
    requests.sort((a, b) => {
        if ( a.documentId !== b.documentId ) {
            return (a.documentId || '') < (b.documentId || '') ? -1 : 1;
        }
        return (a.timeStamp || 0) - (b.timeStamp || 0);
    });

    const fragment = new DocumentFragment();
    const template = qs$('#auditRecord');
    for ( const record of requests ) {
        if ( record instanceof Object === false ) { continue; }
        fragment.append(renderRecord(record, template));
    }

    dom.empty('#auditEntries');
    qs$('#auditEntries').append(fragment);
    dom.text('#auditCount', `${requests.length} request(s)`);
};

/******************************************************************************/

dom.on('#refresh', 'click', ( ) => { render(); });

dom.on('#reset', 'click', async ( ) => {
    await sendMessage({ what: 'resetAudit', tabId });
    render();
});

/******************************************************************************/

await render();

// Auto-refresh so the view updates live as the audited page keeps loading
// resources. The background dataset persists across navigations.
setInterval(( ) => { render(); }, 1000);

/******************************************************************************/
