/*
* Copyright 2019 Google Inc.
* 
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
* 
*     http://www.apache.org/licenses/LICENSE-2.0
* 
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/
/* jshint esversion: 8 */

/**
 * This node uses the GCP Speech to Text API.  The primary documentation for this service can
 * be found here:
 *
 * https://cloud.google.com/speech-to-text/docs/
 * 
 * The JavaScript docs can be found here:
 *
 * https://googleapis.dev/nodejs/speech/latest/index.html
 *
 */
module.exports = function(RED) {
    "use strict";
    const NODE_TYPE = "google-cloud-speech-to-text";
    const speech = require('@google-cloud/speech');


    function SpeechToTextNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        let speechClient = null;
        let credentials = null;

        const sampleRateHertz              = config.sampleRate;
        const encoding                     = config.encoding;
        const languageCode                 = config.languageCode || "en-US";
        const enableWordTimeOffsets        = config.enableWordTimeOffsets === true;
        const model                        = config.model || "default";
        const useEnhanced                  = config.useEnhanced === true;
        const enableAutomaticPunctuation   = config.enableAutomaticPunctuation === true;
        const enableSpeakerDiarization     = config.enableSpeakerDiarization === true;
        const maxAlternatives              = config.maxAlternatives || 1;

        if (config.account) {
            credentials = GetCredentials(config.account);
        }
        const keyFilename = config.keyFilename;

        /**
         * Extract JSON service credentials key from "google-cloud-credentials" config node.
         */
        function GetCredentials(node) {
            return JSON.parse(RED.nodes.getCredentials(node).account);
        } // GetCredentials

        async function Input(msg) {
            let audio;
            if (msg.payload.uri) {
                audio = { "uri": msg.payload.uri };
            } else if (Buffer.isBuffer(msg.payload)) {
                audio = { "content": msg.payload };
            } else {
                node.error("msg.payload must be a Buffer or an object with a uri property");
                return;
            }
            const config = {
                "encoding": encoding,
                "sampleRateHertz": sampleRateHertz,
                "languageCode": languageCode,              // The currently supported languages can be found here https://cloud.google.com/speech-to-text/docs/languages
                "enableWordTimeOffsets": enableWordTimeOffsets,
                "model": model,
                "useEnhanced": useEnhanced,
                "enableAutomaticPunctuation": enableAutomaticPunctuation,
                "enableSpeakerDiarization": enableSpeakerDiarization,
                "maxAlternatives": maxAlternatives
            };
            const request = {
                "audio": audio,
                "config": config
            };
            try {
                node.status({fill: "blue", shape: "dot", text: "processing"});
                let response;
                if (audio.uri) {
                    const [operation] = await speechClient.longRunningRecognize(request);
                    [response] = await operation.promise();
                } else {
                    [response] = await speechClient.recognize(request);
                }
                node.status({});
                const isStructured = enableWordTimeOffsets || enableSpeakerDiarization || maxAlternatives > 1;
                if (isStructured) {
                    msg.payload = response.results.map(result => {
                        const bestAlt = result.alternatives[0];
                        const chunk = {
                            transcript: bestAlt.transcript,
                            confidence: bestAlt.confidence
                        };

                        if (enableWordTimeOffsets && result.resultEndTime) {
                            chunk.startTime = bestAlt.words && bestAlt.words.length > 0
                                ? Number(bestAlt.words[0].startTime.seconds) + bestAlt.words[0].startTime.nanos / 1e9
                                : null;
                            chunk.endTime = Number(result.resultEndTime.seconds) + result.resultEndTime.nanos / 1e9;
                        }

                        if (enableSpeakerDiarization && bestAlt.words) {
                            chunk.words = bestAlt.words.map(w => {
                                const wordObj = { word: w.word, speakerTag: w.speakerTag };
                                if (enableWordTimeOffsets) {
                                    wordObj.startTime = Number(w.startTime.seconds) + w.startTime.nanos / 1e9;
                                    wordObj.endTime = Number(w.endTime.seconds) + w.endTime.nanos / 1e9;
                                }
                                return wordObj;
                            });
                        }

                        if (maxAlternatives > 1) {
                            chunk.alternatives = result.alternatives.map(alt => ({
                                transcript: alt.transcript,
                                confidence: alt.confidence
                            }));
                        }

                        return chunk;
                    });
                } else if (audio.uri) {
                    msg.payload = response.results
                        .map(result => result.alternatives[0].transcript)
                        .join(" ");
                } else {
                    msg.payload = response;
                }
                node.send(msg);
            }
            catch(exp) {
                node.status({});
                node.error(exp);
            }
        } // Input

        // We must have EITHER credentials or a keyFilename.  If neither are supplied, that
        // is an error.  If both are supplied, then credentials will be used.
        if (credentials) {
            speechClient = new speech.SpeechClient({  // SpeechClient comes from @google-cloud/speech
                "credentials": credentials
            });
        } else if (keyFilename) {
            speechClient = new speech.SpeechClient({
                "keyFilename": keyFilename
            });
        } else {
            speechClient = new speech.SpeechClient({});
        }

        node.on("input", Input);
    } // SpeechToTextNode

    RED.nodes.registerType(NODE_TYPE, SpeechToTextNode);
};