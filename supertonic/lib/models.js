// Model registry — defines every Supertonic version the extension can use.
// The active model ID is persisted in chrome.storage.local as 'selectedModel'.

const MODELS = {
    'supertonic-1': {
        id: 'supertonic-1',
        name: 'Supertonic 1',
        description: 'English-only, original release',
        baseUrl: 'https://huggingface.co/Supertone/supertonic/resolve/main',
        languages: [
            { code: 'en', name: 'English' }
        ],
        voiceStyles: ['M1', 'M2', 'F1', 'F2']
    },
    'supertonic-2': {
        id: 'supertonic-2',
        name: 'Supertonic 2',
        description: '5 languages, same speed as v1',
        baseUrl: 'https://huggingface.co/Supertone/supertonic-2/resolve/main',
        languages: [
            { code: 'en', name: 'English' },
            { code: 'ko', name: 'Korean' },
            { code: 'es', name: 'Spanish' },
            { code: 'pt', name: 'Portuguese' },
            { code: 'fr', name: 'French' }
        ],
        voiceStyles: ['M1', 'M2', 'F1', 'F2']
    },
    'supertonic-3': {
        id: 'supertonic-3',
        name: 'Supertonic 3',
        description: '31 languages, custom voices',
        baseUrl: 'https://huggingface.co/Supertone/supertonic-3/resolve/main',
        languages: [
            { code: 'en', name: 'English' },
            { code: 'ko', name: 'Korean' },
            { code: 'ja', name: 'Japanese' },
            { code: 'es', name: 'Spanish' },
            { code: 'pt', name: 'Portuguese' },
            { code: 'fr', name: 'French' },
            { code: 'de', name: 'German' },
            { code: 'it', name: 'Italian' },
            { code: 'nl', name: 'Dutch' },
            { code: 'pl', name: 'Polish' },
            { code: 'ru', name: 'Russian' },
            { code: 'tr', name: 'Turkish' },
            { code: 'ar', name: 'Arabic' },
            { code: 'hi', name: 'Hindi' },
            { code: 'vi', name: 'Vietnamese' },
            { code: 'id', name: 'Indonesian' },
            { code: 'sv', name: 'Swedish' },
            { code: 'da', name: 'Danish' },
            { code: 'fi', name: 'Finnish' },
            { code: 'nb', name: 'Norwegian' },
            { code: 'uk', name: 'Ukrainian' },
            { code: 'cs', name: 'Czech' },
            { code: 'el', name: 'Greek' },
            { code: 'ro', name: 'Romanian' },
            { code: 'hu', name: 'Hungarian' },
            { code: 'bg', name: 'Bulgarian' },
            { code: 'hr', name: 'Croatian' },
            { code: 'sk', name: 'Slovak' },
            { code: 'sl', name: 'Slovenian' },
            { code: 'et', name: 'Estonian' },
            { code: 'lv', name: 'Latvian' },
            { code: 'lt', name: 'Lithuanian' }
        ],
        voiceStyles: ['M1', 'M2', 'F1', 'F2']
    }
};

const MODEL_IDS = Object.keys(MODELS);
const DEFAULT_MODEL = 'supertonic-3';

function getModel(modelId) {
    return MODELS[modelId] || MODELS[DEFAULT_MODEL];
}

function getModelBaseUrl(modelId) {
    return getModel(modelId).baseUrl;
}

function getLanguagesForModel(modelId) {
    return getModel(modelId).languages;
}

function supportsExpressionTags(modelId) {
    return getModel(modelId).expressionTags;
}

function getVoiceStylesForModel(modelId) {
    return getModel(modelId).voiceStyles;
}

export { MODELS, MODEL_IDS, DEFAULT_MODEL, getModel, getModelBaseUrl, getLanguagesForModel, getVoiceStylesForModel };

// CommonJS compat for Jest tests
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { MODELS, MODEL_IDS, DEFAULT_MODEL, getModel, getModelBaseUrl, getLanguagesForModel, getVoiceStylesForModel };
}
