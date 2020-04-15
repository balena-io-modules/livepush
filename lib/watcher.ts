import * as chokidar from 'chokidar';
import * as _ from 'lodash';

import Livepush from './livepush';

interface FsWatcherOpts {
	noInit?: boolean;
	ignored?: string | RegExp | ((str: string) => boolean);
	debounceWait?: number;
}

export function setupFsWatcher(
	livepush: Livepush,
	path: string,
	opts?: FsWatcherOpts,
) {
	const noInit = opts?.noInit ?? true;

	const executor = getExecutor(livepush, opts?.debounceWait ?? 200);

	const watcher = chokidar.watch(path, {
		ignoreInitial: noInit,
		ignored: opts?.ignored,
	});

	watcher.on('add', filepath => executor(filepath));
	watcher.on('change', filepath => executor(filepath));
	watcher.on('unlink', filepath => executor(undefined, filepath));
}

function getExecutor(livepush: Livepush, debounceWait: number) {
	const changedFiles: string[] = [];
	const deletedFiles: string[] = [];
	const actualExecutor = _.debounce(async () => {
		await livepush.performLivepush(changedFiles, deletedFiles);
		changedFiles.length = 0;
		deletedFiles.length = 0;
	}, debounceWait);

	return (changed?: string, deleted?: string) => {
		if (changed) {
			changedFiles.push(changed);
		}
		if (deleted) {
			deletedFiles.push(deleted);
		}
		actualExecutor();
	};
}
