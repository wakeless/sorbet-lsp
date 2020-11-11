/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as path from 'path';
import * as vscode from 'vscode';
import * as child_process from 'child_process';
import { workspace as Workspace, ExtensionContext, env, WorkspaceFolder, TextDocument, Uri } from 'vscode';
import { platform } from 'os';
import crossSpawn = require('cross-spawn');
import shellEscape = require('shell-escape');


import {
	LanguageClient,
	LanguageClientOptions,
	Disposable,
	ServerOptions,
	RevealOutputChannelOn,
} from 'vscode-languageclient';

// let client: LanguageClient;
let clients: Map<string, LanguageClient> = new Map();

const spawnWithBash = (cmd, opts) => {
	if (platform().match(/darwin|linux/)) {
		// OSX and Linux need to use an explicit login shell in order to find
		// the correct Ruby environment through installation managers like rvm
		// and rbenv.
		var shell = env.shell || '/bin/bash';
		if (shell.endsWith('bash') || shell.endsWith('zsh')) {
			var shellCmd = shellEscape(cmd);
			shellCmd = `${shellEscape(['cd', opts['cwd']])} && ${shellCmd}`;
			var shellArgs = [shellCmd];
			shellArgs.unshift('-c');
			shellArgs.unshift('-l');
			return child_process.spawn(shell, shellArgs, { shell, ...opts });
		} else {
			return crossSpawn(cmd.shift(), cmd, opts);
		}
	} else {
		return crossSpawn(cmd.shift(), cmd, opts);
	}
}

export function activate(context: ExtensionContext) {
	let disposableClient: Disposable;
	let cmd = [];

	let vsconfig = vscode.workspace.getConfiguration('sorbet');
	const commandPath = vsconfig.commandPath || 'srb';
	const useBundler = vsconfig.useBundler;
	const useWatchman = vsconfig.useWatchman;
	const bundlerPath = vsconfig.bundlerPath || 'bundle';

	if (useBundler) {
		cmd = cmd.concat([bundlerPath, 'exec', 'srb']);
	} else {
		cmd.push(commandPath);
	}

	cmd = cmd.concat(['tc', '--lsp', '--enable-all-experimental-lsp-features']);

	if (!useWatchman) {
		cmd.push('--disable-watchman');
	}

	function didOpenTextDocument(document: TextDocument): void {
		// We are only interested in language mode text
		if (document.languageId !== 'ruby' || (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled')) {
			return;
		}
		let uri = document.uri;
		// Untitled files are ignored
		if (uri.scheme === 'untitled') {
			return;
		}

		let folder = Workspace.getWorkspaceFolder(uri);
		// Files outside a folder can't be handled. This might depend on the language.
		// Single file languages like JSON might handle files outside the workspace folders.
		if (!folder) {
			return;
		}
		// If we have nested workspace folders we only start a server on the outer most workspace folder.
		folder = getOuterMostWorkspaceFolder(folder);

		if (!clients.has(folder.uri.toString())) {
			let debugOptions = { execArgv: ["--nolazy", `--inspect=${6011 + clients.size}`] };

			let opts = {
				'cwd': folder.uri.toString()
			}

			const serverOptions: ServerOptions = () => {
				return new Promise((resolve) => {
					let child = spawnWithBash(cmd, opts);
					child.stderr.on('data', (data: Buffer) => {
						console.log(data.toString());
					});
					child.on('exit', (code, signal) => {
						console.log('Sorbet exited with code', code, signal);
					});
					resolve(child);
				});
			}

			let clientOptions: LanguageClientOptions = {
				// Register the server for plain text documents
				documentSelector: [{ scheme: 'file', language: 'ruby' }],
				synchronize: {
					// Notify the server about changes to relevant files in the workspace
					fileEvents: Workspace.createFileSystemWatcher('{**/*.rb,**/*.gemspec,**/Gemfile}')
				},
				outputChannelName: 'Sorbet Language Server',
				revealOutputChannelOn: RevealOutputChannelOn.Never,
				workspaceFolder: folder,
			};
			let client = new LanguageClient(
				'sorbetLanguageServer',
				'Sorbet Language Server',
				serverOptions,
				clientOptions
			);
			client.start();
			clients.set(folder.uri.toString(), client);
		}
	}

	Workspace.onDidOpenTextDocument(didOpenTextDocument);
	Workspace.textDocuments.forEach(didOpenTextDocument);
	Workspace.onDidChangeWorkspaceFolders((event) => {
		for (let folder of event.removed) {
			let client = clients.get(folder.uri.toString());
			if (client) {
				clients.delete(folder.uri.toString());
				client.stop();
			}
		}
	});
}

export function deactivate(): Thenable<void> {
	let promises: Thenable<void>[] = [];
	for (let client of clients.values()) {
		promises.push(client.stop());
	}
	return Promise.all(promises).then(() => undefined);
}

let _sortedWorkspaceFolders: string[] | undefined;
function sortedWorkspaceFolders(): string[] {
	if (_sortedWorkspaceFolders === void 0) {
		_sortedWorkspaceFolders = Workspace.workspaceFolders ? Workspace.workspaceFolders.map(folder => {
			let result = folder.uri.toString();
			if (result.charAt(result.length - 1) !== '/') {
				result = result + '/';
			}
			return result;
		}).sort(
			(a, b) => {
				return a.length - b.length;
			}
		) : [];
	}
	return _sortedWorkspaceFolders;
}
Workspace.onDidChangeWorkspaceFolders(() => _sortedWorkspaceFolders = undefined);

function getOuterMostWorkspaceFolder(folder: WorkspaceFolder): WorkspaceFolder {
	let sorted = sortedWorkspaceFolders();
	for (let element of sorted) {
		let uri = folder.uri.toString();
		if (uri.charAt(uri.length - 1) !== '/') {
			uri = uri + '/';
		}
		if (uri.startsWith(element)) {
			return Workspace.getWorkspaceFolder(Uri.parse(element))!;
		}
	}
	return folder;
}
