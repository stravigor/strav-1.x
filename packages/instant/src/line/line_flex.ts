/**
 * `flex` — typed builder for LINE Flex Messages.
 *
 * Flex JSON is rich enough that hand-writing it gets painful fast.
 * The builders re-export the SDK's underlying types via
 * pass-through functions that fill in the `type` discriminator and
 * narrow option bags. The output is plain JSON assignable to
 * `FlexContainer` / `FlexComponent`, which the driver wraps in a
 * `FlexMessage` when sending.
 *
 * Apps that need a shape not covered here (very rare — there are
 * only ~9 components) hand-write the JSON; everything composes.
 */

import type { messagingApi } from '@line/bot-sdk'

type FlexBubble = messagingApi.FlexBubble
type FlexCarousel = messagingApi.FlexCarousel
type FlexBox = messagingApi.FlexBox
type FlexText = messagingApi.FlexText
type FlexButton = messagingApi.FlexButton
type FlexImage = messagingApi.FlexImage
type FlexSeparator = messagingApi.FlexSeparator
type FlexComponent = messagingApi.FlexComponent
type FlexContainer = messagingApi.FlexContainer
type Action = messagingApi.Action

export interface BubbleInput {
  size?: FlexBubble['size']
  direction?: FlexBubble['direction']
  header?: FlexBox
  hero?: FlexImage | FlexBox
  body?: FlexBox
  footer?: FlexBox
  styles?: FlexBubble['styles']
}

function bubble(input: BubbleInput): FlexBubble {
  return { type: 'bubble', ...input } as FlexBubble
}

function carousel(bubbles: FlexBubble[]): FlexCarousel {
  return { type: 'carousel', contents: bubbles }
}

function box(
  layout: FlexBox['layout'],
  contents: FlexComponent[],
  options: Omit<FlexBox, 'type' | 'layout' | 'contents'> = {},
): FlexBox {
  return { type: 'box', layout, contents, ...options }
}

function text(value: string, options: Omit<FlexText, 'type' | 'text'> = {}): FlexText {
  return { type: 'text', text: value, ...options }
}

function button(options: Omit<FlexButton, 'type'>): FlexButton {
  return { type: 'button', ...options }
}

function image(url: string, options: Omit<FlexImage, 'type' | 'url'> = {}): FlexImage {
  return { type: 'image', url, ...options }
}

function separator(options: Omit<FlexSeparator, 'type'> = {}): FlexSeparator {
  return { type: 'separator', ...options }
}

function messageAction(label: string, text: string): Action {
  return { type: 'message', label, text }
}

function postbackAction(
  label: string,
  data: string,
  options: { displayText?: string } = {},
): Action {
  return { type: 'postback', label, data, ...options }
}

function uriAction(label: string, uri: string): Action {
  return { type: 'uri', label, uri }
}

/**
 * Flex builder facade. Importable as a namespace:
 *
 *   import { flex } from '@strav/instant/line'
 *   const bubble = flex.bubble({ body: flex.box('vertical', [flex.text('Hi')]) })
 */
export const flex = {
  bubble,
  carousel,
  box,
  text,
  button,
  image,
  separator,
  action: {
    message: messageAction,
    postback: postbackAction,
    uri: uriAction,
  },
}

export type {
  FlexBox,
  FlexBubble,
  FlexButton,
  FlexCarousel,
  FlexComponent,
  FlexContainer,
  FlexImage,
  FlexSeparator,
  FlexText,
}
