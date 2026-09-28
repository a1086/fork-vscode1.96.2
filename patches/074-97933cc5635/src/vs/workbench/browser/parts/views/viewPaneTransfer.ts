/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ViewPane } from './viewPane.js';
import type { IViewDescriptor } from '../../../common/views.js';

// Shared transfer channel that lets a `ViewPane` instance survive being moved
// from one location (Panel / Side Bar / Auxiliary Bar / Editor) to another
// without being recreated (which would reload the view's content).
//
// The source container parks its pane here right before the view descriptor is
// removed, and the destination container takes it back when the descriptor is
// (re)added. A module level `movingViewIds` set distinguishes a move from a
// genuine removal (hide / dispose) so panes are only parked during moves.

export interface ParkedViewPane {
	pane: ViewPane;
	descriptor: IViewDescriptor;
	input?: unknown;
	headerHidden: boolean;
	owned: boolean;
	seq?: number;
}

const movingViewIds = new Set<string>();
const parkedViewPanes = new Map<string, ParkedViewPane>();
let parkSeq = 0;

export function beginViewMove(viewIds: string[]): void {
	for (const id of viewIds) {
		movingViewIds.add(id);
	}
}

export function endViewMove(viewIds: string[]): void {
	for (const id of viewIds) {
		movingViewIds.delete(id);
	}
}

export function isViewMoving(viewId: string): boolean {
	return movingViewIds.has(viewId);
}

export function parkViewPane(entry: ParkedViewPane): void {
	entry.seq = ++parkSeq;
	console.log('PK', entry.pane.id, entry.seq);
	parkedViewPanes.set(entry.pane.id, entry);
}

export function takeViewPane(viewId: string): ParkedViewPane | undefined {
	const entry = parkedViewPanes.get(viewId);
	if (entry) {
		parkedViewPanes.delete(viewId);
		console.log('TK', viewId, entry.seq);
	} else {
		console.log('TK', viewId, 'miss');
	}
	return entry;
}

export function isViewPaneParked(viewId: string): boolean {
	return parkedViewPanes.has(viewId);
}
