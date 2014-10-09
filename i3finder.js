#!/usr/bin/env node

var nomnom = require('nomnom');
var child_process = require('child_process');
var _ = require('lodash');
var Promise = require('promise');
var fs = require('fs');

var options = nomnom
	.script('i3finder')
	.help('I3 finder is used to focus or move i3 windows and workspaces. If the action '   +
	'argument is not specified, the chosen item is focused. The dmenu, and workspacePrefix ' +
	'arguments already have reasonable defaults, but are used to customize the look of ' + 
	'the choices in dmenu.')
	.option('move',{
		abbr: 'm',
		flag : true,
		help : "grab element and move it to current workspace"
	})
	.option('dmenu',{
		abbr : 'd',
		help : 'the dmenu command and arguments',
		default : ['dmenu'],
		transform : function(commandString){
			return commandString.split(' ');
		}
	})
	.option('workspacePrefix',{
		abbr : 'w',
		default : 'workspace: ',
		help : 'workspace displayname prefix (to tell them apart from other windows)'
	})
	.option('showScratch',{
		abbr: 's',
		flag : true,
		help: 'Show scratch workspace in list'
	})
	.option('dontTrackState',{
		abbr: 't',
		flag : true,
		help : 'Dont bother saving current state'
	})
	.option('action',{
		abbr : 'a',
		choices : ['move','focus','back'],
		default : 'focus',
		help : 'action to perform'

	})
	.parse();

if(options.action === 'back'){
	doBackFocus();
}else{
	doDmenuChoice();
}


/**
* Use dmenu to show a list of workspaces/windows to act on
*/
function doDmenuChoice(){
	//use i3-msg then convert the tree into a sequence of relevant nodes
	var nodes = 
		getNodes()
		.then(function(seq){
			var	currentFocused = _(seq).find('focused');
			return _(seq).without(currentFocused);
		});

	//format the nodes, then show them as choices in dmenu
	var choices = nodes.then(nodesToChoices);
	var dmenuOutput = choices.then(function(choices){
		var dmenuInput = 
			_(choices)
			.pluck('display')
			.join('\n');

		return exec(options.dmenu,dmenuInput);
	});

	//find the choice selected by matching the output from dmenu
	var dmenuChoice = Promise.all([choices,dmenuOutput]).then(function(results){
		var choices = results[0];
		var output = results[1].trim();

		return choices
			.find(function(c){
				return c.display === output;
			});
	});

	//use the choice to either focus or move the selection (by id)
	dmenuChoice.done(function(choice){

		//canceled out of dmenu, do nothing and exit
		if(choice === undefined)
			return;

		var id = choice.id;

		var actions = {
			focus : ['focus'],
			move : ['move','workspace','current'] 
		};
		var action = actions[options.action];

		//save the state before we mess with things	
		saveCurrentState().done(function(){
			//call the action on the node chosen
			var command =  ['i3-msg'].concat(['[con_id=' + id + "]"]).concat(action);
			exec(command).done(console.log);
		});
		
	});
}

/**
* Return the workspace visibility and window focus back to what it was
* last time it was saved by i3finder.
*/
function doBackFocus(){
	getLastState()
	.done(function(lastState){
		var focusCommands =
			_(lastState.workspaces).map(function(w){
				return "workspace " + w;
			})
			.value()
			.concat(['[con_id=' + lastState.node	+ '] focus'])
			.join(';');

		//save the state before we mess with things
		saveCurrentState().then(function(){
			//focus workspaces and window
			exec(['i3-msg'].concat([focusCommands]));
		});

	});
}

function getNodes(){
	var getTreeCommand = ['i3-msg', '-t', 'get_tree'];

	return exec(getTreeCommand)
		.then(JSON.parse)
		.then(nodeTreeToSeq);
}

function getVisibleWorkspaces(){
	var command = ['i3-msg','-t','get_workspaces'];
	return exec(command)
	.then(JSON.parse)
	.then(function(workspaces){
		return _(workspaces)
			.filter('visible')
			.value();
	});
}

function getFocusedNode(){
	return getNodes()
	.then(function(nodes){
		return _(nodes).find('focused');
	});
}

function getLastState(){
	var readFile = Promise.denodeify(fs.readFile);
	return readFile('./lastState.json','utf8')
		.then(JSON.parse);
}

/**
* Writes the current workspace visibility and window focus to a json file.
* returns a promise of when its finished gathering what it needs from I3
* and its safe to mess with the tree.
*/
function saveCurrentState(){

	if(options.dontTrackState){
		return Promsie.resolve();	
	}

	var workspaces = getVisibleWorkspaces();
	var node = getFocusedNode();

	var info = Promise.all([workspaces,node]);

	info.done(function(results){
		var workspaces = results[0];
		var node = results[1];

		var fileContent = JSON.stringify({
			workspaces : _.pluck(workspaces,'name'),
			node : node.id
		});

		fs.writeFile('./lastState.json',fileContent,function(error){
			if(error){
				console.log(error);
			}
		});
	});

	return info;
	
}

/**
* execute a command with a child process, and provides a promise of the 
* output. The process is fed the input arg on stdin (if defined)
*/
function exec(command,input){
	return new Promise(function(resolve,reject){
		var exe = _.first(command);
		var args = _.rest(command);
		var child = child_process.spawn(exe,args);
		child.stdin.setEncoding = 'utf-8';

		var output = "";
		child.stdout.on('data',function(part){
			output += part;
		});

		child.stderr.pipe(process.stderr);

		child.stdout.on('end',function(){
			resolve(output);
		});
		
		if(input !== undefined)
			child.stdin.write(input);

		child.stdin.end();
	});
}

/**
* given a node, provide it and its children in sequence (recursively)
*/
function nodeAndChildren(node){
	var subNodes = 
		_(node.nodes)
		.map(nodeAndChildren)
		.value();

	return [node].concat(subNodes);
}

/**
* reduce a i3 tree into a sequence of nodes, filtering irrelevant ones 
*/
function nodeTreeToSeq(tree){
	return _(nodeAndChildren(tree))
		.flatten()
		.filter(function(n){
			return (n.type === 'con' && n.window !== null) || 
					n.type === 'workspace'; 
		})
		.filter(function(n){
			var isSratch = _.contains(n.name,'__i3_scratch');
			return options.showScratch | !isSratch;
		});
}

/**
* convert nodes into a human readable choices
*/
function nodesToChoices(nodes){
	return nodes.map(function(node){
		var id = node.id;
		var display = "";
		if(node.mark !== undefined){
			display += node.mark + ": ";
		}
		if(node.type === 'workspace'){
			display += options.workspacePrefix;
		}
		display += node.name;
		return {display : display, id : id};
	});	
}

