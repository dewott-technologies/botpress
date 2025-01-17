import { MLToolkit } from 'botpress/sdk'
import _ from 'lodash'

import { Intent, Utterance, UtteranceToken } from './engine2'
import { computeQuantile } from '../tools/math'
import { countAlpha, countNum, countSpecial } from '../tools/strings'
import { MAX_TFIDF, MIN_TFIDF } from '../pipelines/intents/tfidf'
import { sanitize } from '../pipelines/language/sanitizer'

type FeatureValue = string | number | boolean

export interface CRFFeature {
  name: string
  value: FeatureValue
  boost?: number
}

const TFIDF_WEIGHTS = ['low', 'medium', 'high']

export function featToCRFsuiteAttr(prefix: string, feat: CRFFeature): string {
  return `${prefix}${feat.name}=${feat.value}:${feat.boost || 1}`
}

export function getFeatPairs(feats0: CRFFeature[], feats1: CRFFeature[], featNames: string[]): CRFFeature[] {
  const valueOf = (feat: CRFFeature | undefined): FeatureValue => _.get(feat, 'value', 'null')
  const boostOf = (feat: CRFFeature | undefined): number => _.get(feat, 'boost', 1)

  return featNames
    .map(targetFeat => {
      const f0 = feats0.find(f => f.name === targetFeat)
      const f1 = feats1.find(f => f.name === targetFeat)

      if (f0 || f1) {
        return {
          name: targetFeat,
          value: `${valueOf(f0)}|${valueOf(f1)}`,
          boost: Math.max(boostOf(f0), boostOf(f1))
        }
      }
    })
    .filter(_.identity)
}

export function getWordWeight(token: UtteranceToken): CRFFeature {
  const tierce = computeQuantile(3, token.tfidf, MAX_TFIDF, MIN_TFIDF)
  const value = TFIDF_WEIGHTS[tierce - 1]

  return {
    name: 'weight',
    value
  }
}

export function getClusterFeat(token: UtteranceToken): CRFFeature {
  return {
    name: 'cluster',
    value: token.cluster
  }
}

export function getWordFeat(token: UtteranceToken, isPredict: boolean): CRFFeature | undefined {
  const boost = isPredict ? 3 : 1

  if (_.isEmpty(token.entities) && token.isWord) {
    return {
      name: 'word',
      value: token.toString({ lowerCase: true }),
      boost
    }
  }
}

export function getInVocabFeat(token: UtteranceToken, intent: Intent<Utterance>): CRFFeature {
  const inVocab = !!intent.vocab[token.toString({ lowerCase: true })]
  return {
    name: 'inVocab',
    value: inVocab
  }
}

export function getEntitiesFeats(token: UtteranceToken, allowedEntities: string[], isPredict: boolean): CRFFeature[] {
  const boost = isPredict ? 3 : 1

  return _.chain(token.entities)
    .map(e => e.type)
    .intersectionWith(allowedEntities)
    .thru(ents => (ents.length ? ents : ['none']))
    .map(entity => ({
      name: 'entity',
      value: entity,
      boost
    }))
    .value()
}

export function getSpaceFeat(token: UtteranceToken | undefined): CRFFeature {
  return {
    name: 'space',
    value: token && token.isSpace
  }
}

export function getNum(token: UtteranceToken): CRFFeature {
  return {
    name: 'num',
    value: countNum(token.value)
  }
}

export function getAlpha(token: UtteranceToken): CRFFeature {
  return {
    name: 'alpha',
    value: countAlpha(token.value)
  }
}

export function getSpecialChars(token: UtteranceToken): CRFFeature {
  return {
    name: 'special',
    value: countSpecial(token.value)
  }
}

export function getIntentFeature(intent: Intent<Utterance>): CRFFeature {
  return {
    name: 'intent',
    value: sanitize(intent.name.replace(/\s/g, '')),
    boost: 100
  }
}

export function getTokenQuartile(utterance: Utterance, token: UtteranceToken): CRFFeature {
  return {
    name: 'quartile',
    value: computeQuantile(4, token.index + 1, utterance.tokens.length)
  }
}
