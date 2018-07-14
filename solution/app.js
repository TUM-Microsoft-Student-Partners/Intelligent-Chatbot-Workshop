var restify = require('restify');
var builder = require('botbuilder');
var mvg = require('mvgapi');
var moment = require('moment');

// Setup Restify Server
var server = restify.createServer();
server.listen(process.env.port || process.env.PORT || 3978, function () {
	console.log('%s listening to %s', server.name, server.url);
});

// Create chat connector for communicating with the Bot Framework Service
var connector = new builder.ChatConnector({
	appId: process.env.MicrosoftAppId || 'INSERT APP ID HERE',
	appPassword: process.env.MicrosoftAppPassword || ' INSERT APP PASSWORD HERE',
	openIdMetadata: process.env.BotOpenIdMetadata
});

// Listen for messages from users 
server.post('/api/messages', connector.listen());

// Create your bot with a function to receive messages from the user
// This default message handler is invoked if the user's utterance doesn't
// match any intents handled by other dialogs.
var bot = new builder.UniversalBot(connector, function (session, args) {
	session.send('You reached the default message handler. You said \'%s\'.', session.message.text);
});

// Make sure you add code to validate these fields
var luisAppId = process.env.LuisAppId || 'INSERT LUIS APP ID HERE';
var luisAPIKey = process.env.LuisAPIKey || 'INSERT LUIS API KEY HERE';
var luisAPIHostName = process.env.LuisAPIHostName || 'westeurope.api.cognitive.microsoft.com'; // change to westus.api.cognitive.microsoft.com, if your LUIS service is hosted in the US 

const LuisModelUrl = 'https://' + luisAPIHostName + '/luis/v2.0/apps/' + luisAppId + '?subscription-key=' + luisAPIKey;

// Create a recognizer that gets intents from LUIS, and add it to the bot
var recognizer = new builder.LuisRecognizer(LuisModelUrl);
bot.recognizer(recognizer);

// Add a dialog for each intent that the LUIS app recognizes.
// See https://docs.microsoft.com/en-us/bot-framework/nodejs/bot-builder-nodejs-recognize-intent-luis 
bot.dialog('GreetingDialog',
	(session) => {
		session.send('Hi there! I\'m your personal MVG-Assistant :)', session.message.text);
		session.endDialog();
	}
).triggerAction({
	matches: 'Greeting'
})

bot.dialog('HelpDialog',
	(session) => {
		session.send('You reached the Help intent. You said \'%s\'.', session.message.text);
		session.endDialog();
	}
).triggerAction({
	matches: 'Help'
})

bot.dialog('CancelDialog',
	(session) => {
		session.send('You reached the Cancel intent. You said \'%s\'.', session.message.text);
		session.endDialog();
	}
).triggerAction({
	matches: 'Cancel'
})

// Add the Route Dialog, which is being started, if the Route-Intent was triggered by LUIS
bot.dialog('Route', [(session, args, next) => {
	let intent = args.intent;

	// Parse entities parsed by LUIS
	// In this dialog, we are interested in two Station-Entities
	let entities = builder.EntityRecognizer.findAllEntities(args.intent.entities, 'Station') || [];

	// If only one was found, we assume that the end station was inserted ("I want to go to garching", no one says "I want to go from garching")
	if (entities.length == 1) {
		session.dialogData.end = entities[0].entity;
	}
	else if (entities.length > 1) {
		session.dialogData.start = entities[0].entity;
		session.dialogData.end = entities[1].entity;
	}
	next();
},
// Use waterfalling principle and get the required information
(session, results, next) => {
	if (!session.dialogData.start) {
		builder.Prompts.text(session, 'Please enter your start station');
	}
	next();
},
(session, results, next) => {
	if (results.response) {
		session.dialogData.start = results.response;
	}
	if (!session.dialogData.end) {
		builder.Prompts.text(session, 'Please enter your end station');
	}
	next();
},
(session, results, next) => {
	if (results.response) {
		session.dialogData.end = results.response;
	}
	next();
},
(session, results) => {
	let start = session.dialogData.start;
	let end = session.dialogData.end;

	// Should not happen
	if (!start || !end) {
		console.error("Something went wrong. Start or End Location is undefined");
	}

	session.send("All right. I'm searching for routes from " + start.toUpperCase() + " to " + end.toUpperCase());
	// Use the mvg API to find locations IDs
	mvg.searchForLocations(start).then(locationsStart => {
		if (locationsStart.length > 0) {
			let startID = locationsStart[0].id;

			mvg.searchForLocations(end).then(locationsEnd => {
				if (locationsEnd.length > 0) {
					let endID = locationsEnd[0].id;

					// With the IDs get routes and send them to the user
					mvg.route(startID, endID).then(routes => {
						routes.forEach((route, idx) => {
							session.send(`Route ${idx + 1}\n\n${route.connectionPartList.map(part => `${part.product !== undefined ? (part.product.toUpperCase() + part.label) : 'Footway'}: ${moment(part.departure).format("h:mm a")} ${part.from.name} - ${part.to.name} ${moment(part.arrival).format("h:mm a")}`).join("\n\n")}`);
						});
						if (routes.length == 0) {
							session.send("I couldn't find any routes :/");
						}
					}).catch(err => {
						console.log(`Ups, an error occured: \n ${err}`);
					});
				}
				else {
					session.send(`I couldn't find ${end}`);
				}

			}).catch(err => {
				console.log(`Ups, an error occured: \n ${err}`);
			});

		}
		else {
			session.send(`I couldn't find ${start}`);
		}
	}).catch(err => {
		console.log(`Ups, an error occured: \n ${err}`);
	});
}])
	.triggerAction({
		matches: 'Route'
	});

// Add the Departures Dialog, which is being started, if the Departures-Intent was triggered by LUIS
bot.dialog('Departures', [(session, args, next) => {

	// Parse entities parsed by LUIS
	// In this dialog, we are interested in one Station-Entity
	let station = builder.EntityRecognizer.findEntity(args.intent.entities, 'Station');

	// If one was found, set the response for the next dialog step
	if (station) {
		next({ response: station.entity })
	}
	else {
		// If not found, ask the user for it
		builder.Prompts.text(session, "Of which station do you need departure information?")
	}
},
(session, results) => {
	// Use the response from the previous step
	let station = results.response;

	// Use the mvg api to find more information about the station by its name
	mvg.searchForLocations(station).then(locations => {
		if (locations.length > 0) {
			let stationID = locations[0].id;
			let stationName = locations[0].name;
			// Now get the departure times and send it to the user
			mvg.departures(stationID).then(departures => {
				if (departures.length > 0) {
					session.send(`I found ${departures.length > 10 ? 10 : departures.length} connections from ${stationName}:`);
					departures.filter((v, i) => i < 10).forEach(departure => {
						session.send(`${departure.product.toUpperCase()}${departure.label}: ${moment(departure.departureTime).format("h:mm a")} in direction ${departure.destination}`);
					});
				}
			}).catch(err => {
				console.log(`Ups, an error occured: \n ${err}`);
			});
		}
		else
			session.send("I couldn't find any information :/");
	}).catch(err => {
		console.log(`Ups, an error occured: \n ${err}`);
	});
}])
	.triggerAction({
		matches: 'Departures'
	})