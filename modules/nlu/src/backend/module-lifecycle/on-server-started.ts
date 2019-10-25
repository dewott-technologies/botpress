import * as sdk from 'botpress/sdk'
import _ from 'lodash'
import yn from 'yn'

import { Config } from '../../config'
import ScopedEngine from '../engine'
import Engine2, { Tools } from '../engine2/engine2'
import { NLUState } from '../index'
import LangProvider from '../language-provider'
import { DucklingEntityExtractor } from '../pipelines/entities/duckling_extractor'
import Storage from '../storage'

export const initializeLanguageProvider = async (bp: typeof sdk, state: NLUState) => {
  const globalConfig = (await bp.config.getModuleConfig('nlu')) as Config

  try {
    const languageProvider = await LangProvider.initialize(globalConfig.languageSources, bp.logger)
    const { validProvidersCount, validLanguages } = languageProvider.getHealth()
    const health = {
      isEnabled: validProvidersCount > 0 && validLanguages.length > 0,
      validProvidersCount,
      validLanguages
    }

    state.languageProvider = languageProvider
    state.health = health
  } catch (e) {
    if (e.failure && e.failure.code === 'ECONNREFUSED') {
      bp.logger.error(`Language server can't be reached at adress ${e.failure.address}:${e.failure.port}`)
      if (!process.IS_FAILSAFE) {
        process.exit()
      }
    }
    throw e
  }
}

function initializeEngine2(bp: typeof sdk, state: NLUState) {
  const tools: Tools = {
    tokenize_utterances: (utterances, lang) => state.languageProvider.tokenize(utterances, lang),
    vectorize_tokens: async (tokens, lang) => {
      const a = await state.languageProvider.vectorize(tokens, lang)
      return a.map(x => Array.from(x.values()))
    },
    generateSimilarJunkWords: (vocab: string[], lang: string) =>
      state.languageProvider.generateSimilarJunkWords(vocab, lang),
    mlToolkit: bp.MLToolkit,
    ducklingExtractor: new DucklingEntityExtractor(bp.logger)
  }
  Engine2.provideTools(tools)
}

async function initDucklingExtractor(bp: typeof sdk): Promise<void> {
  const globalConfig = (await bp.config.getModuleConfig('nlu')) as Config
  await DucklingEntityExtractor.configure(globalConfig.ducklingEnabled, globalConfig.ducklingURL, bp.logger)
}

const USE_E1 = yn(process.env.USE_LEGACY_NLU)
const EVENTS_TO_IGNORE = ['session_reference', 'session_reset', 'bp_dialog_timeout', 'visit', 'say_something', '']

const registerMiddleware = async (bp: typeof sdk, state: NLUState) => {
  const { nluByBot, health, e2ByBot } = state
  bp.events.registerMiddleware({
    name: 'nlu.incoming',
    direction: 'incoming',
    order: 10,
    description:
      'Process natural language in the form of text. Structured data with an action and parameters for that action is injected in the incoming message event.',
    handler: async (event: sdk.IO.IncomingEvent, next: sdk.IO.MiddlewareNextCallback) => {
      if (!health.isEnabled) {
        return next()
      }

      const botCtx = USE_E1 ? (nluByBot[event.botId] as ScopedEngine) : e2ByBot[event.botId]

      if (
        !botCtx ||
        !event.preview ||
        EVENTS_TO_IGNORE.includes(event.type) ||
        event.hasFlag(bp.IO.WellKnownFlags.SKIP_NATIVE_NLU)
      ) {
        return next()
      }

      try {
        let nlu = {}
        if (USE_E1) {
          nlu = await (botCtx as ScopedEngine).extract!(
            event.preview,
            event.state.session.lastMessages.map(message => message.incomingPreview),
            event.nlu.includedContexts
          )
        } else {
          nlu = await (botCtx as Engine2).predict(event.preview, event.nlu.includedContexts)
        }

        _.merge(event, { nlu })
        removeSensitiveText(event)
      } catch (err) {
        bp.logger.warn('Error extracting metadata for incoming text: ' + err.message)
      } finally {
        next()
      }
    }
  })

  function removeSensitiveText(event) {
    if (!event.nlu.entities || !event.payload.text) {
      return
    }

    try {
      const sensitiveEntities = event.nlu.entities.filter(ent => ent.sensitive)
      for (const entity of sensitiveEntities) {
        const stars = '*'.repeat(entity.data.value.length)
        event.payload.text = event.payload.text.replace(entity.data.value, stars)
      }
    } catch (err) {
      bp.logger.warn('Error removing sensitive informations: ' + err.message)
    }
  }
}

// TODO use Shared NLUState once implemented
export function registerOnServerStarted(state: NLUState) {
  return async (bp: typeof sdk) => {
    Storage.ghostProvider = (botId?: string) => (botId ? bp.ghost.forBot(botId) : bp.ghost.forGlobal())
    await initDucklingExtractor(bp)
    await initializeLanguageProvider(bp, state)
    initializeEngine2(bp, state)
    await registerMiddleware(bp, state)
  }
}