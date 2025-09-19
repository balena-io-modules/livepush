module.exports = {
	timeout: 600000,
	exit: true,
	require: [
		'source-map-support/register',
		'ts-node/register/transpile-only',
	],
	reporter: 'spec',
	spec: ['test/**/*.spec.ts'],
};
