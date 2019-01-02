declare module 'node-watch' {
	import { watch } from 'fs';

	const watchFn: typeof watch;

	export = watchFn;
}
