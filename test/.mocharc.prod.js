module.exports = {
	timeout: 600000,
	exit: true,
	require: [
		'source-map-support/register',
	],
	spec: ['build/test/**/*.spec.js']
};
