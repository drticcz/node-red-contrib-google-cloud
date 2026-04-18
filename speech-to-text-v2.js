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
 * This node uses the GCP Speech to Text V2 API with Chirp model support.
 * Primary documentation:
 *
 * https://cloud.google.com/speech-to-text/v2/docs/
 *
 * JavaScript docs:
 *
 * https://googleapis.dev/nodejs/speech/latest/index.html
 *
 */
module.exports = function(RED) {
    "use strict";
    const NODE_TYPE = "google-cloud-speech-to-text-v2";
    const { v2 } = require('@google-cloud/speech');


    function SpeechToTextV2Node(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        let speechClient = null;
        let credentials = null;

        const projectId                           = config.projectId;
        const location                            = config.location || "global";
        const model                               = config.model || "chirp";
        const languageCodes                       = config.languageCodes
            ? config.languageCodes.split(",").map(c => c.trim()).filter(Boolean)
            : ["en-US"];
        const enableWordTimeOffsets               = config.enableWordTimeOffsets === true;
        const enableAutomaticPunctuation          = config.enableAutomaticPunctuation === true;
        const enableSpeakerDiarization            = config.enableSpeakerDiarization === true;
        const maxAlternatives                     = config.maxAlternatives || 1;
        const speechContexts                      = config.speechContexts
            ? [{ phrases: config.speechContexts.split(",").map(p => p.trim()).filter(Boolean) }]
            : [];
        const audioChannelCount                   = config.audioChannelCount || 1;
        const enableSeparateRecognitionPerChannel = config.enableSeparateRecognitionPerChannel === true;

        if (config.account) {
            credentials = GetCredentials(config.account);
        }
        const keyFilename = config.keyFilename;

        function GetCredentials(node) {
            return JSON.parse(RED.nodes.getCredentials(node).account);
        } // GetCredentials

        function parseSpeechContexts(value) {
            if (Array.isArray(value)) return value;
            return [{ phrases: String(value).split(",").map(p => p.trim()).filter(Boolean) }];
        }

        function parseLanguageCodes(value) {
            if (Array.isArray(value)) return value;
            return String(value).split(",").map(c => c.trim()).filter(Boolean);
        }

        function buildRecognitionConfig(effectiveLanguageCodes, effectiveAudioChannelCount, effectiveEnableSeparateRecognitionPerChannel, effectiveSpeechContexts) {
            const recognitionConfig = {
                languageCodes: effectiveLanguageCodes,
                model: model,
                features: {
                    enableWordTimeOffsets: enableWordTimeOffsets,
                    enableAutomaticPunctuation: enableAutomaticPunctuation,
                    maxAlternatives: maxAlternatives,
                    multiChannelMode: effectiveEnableSeparateRecognitionPerChannel
                        ? "SEPARATE_RECOGNITION_PER_CHANNEL"
                        : "MULTI_CHANNEL_MODE_UNSPECIFIED"
                }
            };

            if (enableSpeakerDiarization) {
                recognitionConfig.features.diarizationConfig = {
                    enableSpeakerDiarization: true
                };
            }

            if (effectiveAudioChannelCount > 1) {
                recognitionConfig.explicitDecodingConfig = {
                    audioChannelCount: effectiveAudioChannelCount
                };
            } else {
                recognitionConfig.autoDecodingConfig = {};
            }

            if (effectiveSpeechContexts.length > 0) {
                recognitionConfig.adaptation = {
                    phraseSets: effectiveSpeechContexts.map(ctx => ({
                        phrases: ctx.phrases.map(p => ({ value: p }))
                    }))
                };
            }

            return recognitionConfig;
        }

        function buildConfigMask(recognitionConfig) {
            const paths = ["model", "language_codes", "features"];
            if (recognitionConfig.autoDecodingConfig) paths.push("auto_decoding_config");
            if (recognitionConfig.explicitDecodingConfig) paths.push("explicit_decoding_config");
            if (recognitionConfig.adaptation) paths.push("adaptation");
            return { paths };
        }

        function durationToSeconds(duration) {
            return Number(duration.seconds) + duration.nanos / 1e9;
        }

        function formatResults(results, effectiveEnableSeparateRecognitionPerChannel) {
            const isStructured = enableWordTimeOffsets || enableSpeakerDiarization || maxAlternatives > 1 || effectiveEnableSeparateRecognitionPerChannel;

            if (!isStructured) {
                return results.map(r => r.alternatives[0].transcript).join(" ");
            }

            return results.map(result => {
                const bestAlt = result.alternatives[0];
                const chunk = {
                    transcript: bestAlt.transcript,
                    confidence: bestAlt.confidence
                };

                if (effectiveEnableSeparateRecognitionPerChannel && result.channelTag != null) {
                    chunk.channelTag = result.channelTag;
                }

                if (enableWordTimeOffsets && result.resultEndOffset) {
                    chunk.startTime = bestAlt.words && bestAlt.words.length > 0
                        ? durationToSeconds(bestAlt.words[0].startOffset)
                        : null;
                    chunk.endTime = durationToSeconds(result.resultEndOffset);
                }

                if (enableSpeakerDiarization && bestAlt.words) {
                    chunk.words = bestAlt.words.map(w => {
                        const wordObj = { word: w.word, speakerTag: w.speakerTag };
                        if (enableWordTimeOffsets) {
                            wordObj.startTime = durationToSeconds(w.startOffset);
                            wordObj.endTime = durationToSeconds(w.endOffset);
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
        }

        async function Input(msg) {
            let audio;
            if (msg.payload.uri) {
                audio = { uri: msg.payload.uri };
            } else if (Buffer.isBuffer(msg.payload)) {
                audio = { content: msg.payload };
            } else {
                node.error("msg.payload must be a Buffer or an object with a uri property");
                return;
            }

            const effectiveSpeechContexts                      = msg.speechContexts !== undefined               ? parseSpeechContexts(msg.speechContexts)          : speechContexts;
            const effectiveExtraLanguageCodes                  = msg.alternativeLanguageCodes !== undefined     ? parseLanguageCodes(msg.alternativeLanguageCodes)  : [];
            const effectiveAudioChannelCount                   = msg.audioChannelCount !== undefined            ? msg.audioChannelCount                             : audioChannelCount;
            const effectiveEnableSeparateRecognitionPerChannel = msg.enableSeparateRecognitionPerChannel !== undefined ? msg.enableSeparateRecognitionPerChannel    : enableSeparateRecognitionPerChannel;

            const effectiveLanguageCodes = effectiveExtraLanguageCodes.length > 0
                ? [...new Set([...languageCodes, ...effectiveExtraLanguageCodes])]
                : languageCodes;

            const recognizerPath     = `projects/${projectId}/locations/${location}/recognizers/_`;
            const recognitionConfig  = buildRecognitionConfig(effectiveLanguageCodes, effectiveAudioChannelCount, effectiveEnableSeparateRecognitionPerChannel, effectiveSpeechContexts);
            const configMask         = buildConfigMask(recognitionConfig);

            try {
                node.status({ fill: "blue", shape: "dot", text: "processing" });
                let results;

                if (audio.uri) {
                    const [operation] = await speechClient.batchRecognize({
                        recognizer: recognizerPath,
                        config: recognitionConfig,
                        configMask: configMask,
                        files: [{ uri: audio.uri }],
                        recognitionOutputConfig: { inlineResponseConfig: {} }
                    });
                    const [response] = await operation.promise();
                    const fileResult = response.results && response.results[audio.uri];
                    results = fileResult && fileResult.transcript ? fileResult.transcript.results : [];
                } else {
                    const [response] = await speechClient.recognize({
                        recognizer: recognizerPath,
                        config: recognitionConfig,
                        configMask: configMask,
                        content: audio.content
                    });
                    results = response.results || [];
                }

                node.status({});
                msg.payload = formatResults(results, effectiveEnableSeparateRecognitionPerChannel);
                node.send(msg);
            } catch (exp) {
                node.status({});
                node.error(exp);
            }
        } // Input

        const apiEndpoint = location === "global"
            ? "speech.googleapis.com"
            : `${location}-speech.googleapis.com`;

        if (credentials) {
            speechClient = new v2.SpeechClient({ credentials, apiEndpoint });
        } else if (keyFilename) {
            speechClient = new v2.SpeechClient({ keyFilename, apiEndpoint });
        } else {
            speechClient = new v2.SpeechClient({ apiEndpoint });
        }

        node.on("input", Input);
    } // SpeechToTextV2Node

    RED.nodes.registerType(NODE_TYPE, SpeechToTextV2Node);
};
