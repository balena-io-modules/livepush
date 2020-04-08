import { CommandEntry, parse } from 'docker-file-parser';

const LiveCommandDirective = 'dev-cmd-live';
const RunCommandDirective = 'dev-run';
const CopyCommandDirective = 'dev-copy';
const EscapeDirective = 'escape';
const InternalLiveCmdMarker = 'livecmd-marker';

export { CommandEntry };

export function parseDockerfile(content: string | Buffer): CommandEntry[] {
	// This function may look a little weird, but due to bugs
	// in the comment parsing of docker-file-parser we first go
	// through the dockerfile, find out directives, and keep a
	// track of the line number that it was encountered at.
	// We then pass to the docker-file-parser parsing
	// function, with no comments. We then integrate the
	// directive into the returned values using the line
	// number (as the order matters).

	// issue with comments in docker-file-parser:
	// https://github.com/joyent/node-docker-file-parser/issues/8

	if (Buffer.isBuffer(content)) {
		content = content.toString();
	}

	// We keep track of this, as one of the directives can
	// change it
	let escapeCharacter = '\\';
	let lastNonCommentLine = '';

	const directives: CommandEntry[] = [];
	const nonCommentLines = content
		.split(/\r?\n/)
		.map((line, idx) => {
			// If the line is a comment, we're only interested in it
			// if it's a livepush directive
			const comment = extractComment(line);

			if (comment) {
				const directive = extractDirective(comment, idx + 1);
				if (directive) {
					directives.push(directive.entry);

					// Special case, keep track of the escape directive
					if (directive.entry.name === 'ESCAPE') {
						escapeCharacter = (directive.entry.args as string[])[0];
					}

					return directive.preserve ? line : '';
				}
				// We still add an empty line when we encounter a
				// comment, to keep the line numbers consistent
				// If the last non-commented line ends with an
				// escape character, keep that going
				if (lastNonCommentLine.endsWith(escapeCharacter)) {
					return `${escapeCharacter}`;
				}
				return '';
			}
			lastNonCommentLine = line;
			return line;
		})
		.join('\n');

	const commands = parse(nonCommentLines, { includeComments: false });

	// Concatenate the commands and directives, and sort by
	// the line numbers
	return commands.concat(directives).sort((a, b) => a.lineno - b.lineno);
}

function extractComment(line: string) {
	if (/^\s*#+/.test(line)) {
		return line.replace(/^\s*#+\s*(.*)/, '$1');
	}
	return;
}

// TODO: Perhaps make this regex more strict?
const directiveRegex = /([^=]+)=(.+)/;
function extractDirective(
	comment: string,
	lineno: number,
): { entry: CommandEntry; preserve: boolean } | undefined {
	const match = comment.match(directiveRegex);
	if (!match) {
		return;
	}

	const common = {
		args: match[2],
		lineno,
		raw: `#${comment}`,
	};

	switch (match[1].toLowerCase()) {
		case LiveCommandDirective:
			return {
				entry: {
					name: 'LIVECMD',
					...common,
				},
				preserve: false,
			};
		case EscapeDirective:
			return {
				entry: {
					name: 'ESCAPE',
					...common,
				},
				// We have to preserve this in the original
				// dockerfile so that docker-file-parser can handle
				// it correctly
				preserve: true,
			};
		case InternalLiveCmdMarker:
			return {
				entry: {
					name: 'LIVECMD_MARKER',
					...common,
				},
				preserve: false,
			};
		case RunCommandDirective:
			return {
				entry: {
					name: 'LIVERUN',
					...common,
				},
				preserve: false,
			};
		case CopyCommandDirective:
			return {
				entry: {
					name: 'LIVECOPY',
					...common,
				},
				preserve: false,
			};
	}
}
