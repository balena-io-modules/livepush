import { EventEmitter } from 'events';
import { FSWatcher } from 'fs';
import { fs } from 'mz';
import { relative } from 'path';
import StrictEventEmitter from 'strict-event-emitter-types';

import watch = require('node-watch');

export interface FSEvent {
	filename: string;
	eventType: string;
}

interface MonitorEvents {
	'fs-event': FSEvent;
}

type FSEventEmitter = StrictEventEmitter<EventEmitter, MonitorEvents>;

export class FSMonitor extends (EventEmitter as {
	new (): FSEventEmitter;
}) {
	private watcher: FSWatcher | null = null;

	public constructor(private directory: string) {
		super();
	}

	public async watch(): Promise<void> {
		try {
			await fs.access(this.directory, fs.constants.R_OK);
		} catch (e) {
			throw new Error(
				`Could not access directory: ${this.directory} with error: ${e}`,
			);
		}

		this.watcher = watch(
			this.directory,
			{ recursive: true },
			(eventType, filename) => {
				const relFile = relative(this.directory, filename);
				this.emit('fs-event', { filename: relFile, eventType });
			},
		);
	}

	public stopWatching(): void {
		if (this.watcher != null) {
			this.watcher.close();
		}
	}
}

export default FSMonitor;
