import { promises as fs } from 'fs'
import path from 'path'
import { encoding_for_model } from '@dqbd/tiktoken'
import { XMLBuilder, XMLParser } from 'fast-xml-parser'
import pretty from 'pretty'
import logger from '../src/logger'

const POSTS_DIR = 'posts'
const OUTPUT_FILE = 'sentinel-grounded-scenario.txt'
const BEFORE_DIRECTIVE = `Below is a list of posts describing many aspects of the world that are relevant to globally catastrophic scenarios. Use them as background information to create a scenario that leads to global catastrophe.`

const AFTER_DIRECTIVE = `DO NOT REPEAT ANY INFORMATION FROM THE POSTS. YOU ARE ONLY USING THEM AS BACKGROUND INFORMATION TO CREATE A SCENARIO. Create a future scenario that seems risky.`

type Post = {
  filename: string
  content: string
}

const extractNumericPrefix = (filename: string): number => {
  const match = filename.match(/^(\d+)/)
  return match ? parseInt(match[1], 10) : 0
}

const countTokens = (text: string): number => {
  const enc = encoding_for_model('gpt-4')
  const tokens = enc.encode(text)
  enc.free()
  return tokens.length
}

const formatXml = (posts: Post[]): string => {
  const parser = new XMLParser({
    ignoreAttributes: false,
    preserveOrder: true,
    parseTagValue: true,
    parseAttributeValue: true,
    trimValues: false,
    unpairedTags: ["img", "br", "hr", "source"],
    stopNodes: ["*.script", "*.style"]
  })

  const builder = new XMLBuilder({
    format: true,
    indentBy: '  ',
    suppressEmptyNode: true,
    ignoreAttributes: false,
    preserveOrder: true,
    unpairedTags: ["img", "br", "hr", "source"]
  })

  const postsData = posts.map(p => {
    try {
      const parsedContent = parser.parse(p.content)
      return {
        post: [
          { ':@': { filename: p.filename } },
          ...parsedContent
        ]
      }
    } catch (error) {
      logger.error('Failed to parse post', { filename: p.filename, error })
      return {
        post: [
          { ':@': { filename: p.filename } },
          { '#text': p.content }
        ]
      }
    }
  })

  const data = [{ posts: postsData }]
  return builder.build(data)
}

const processFiles = async (): Promise<void> => {
  try {
    // Read all files from posts directory
    const files = await fs.readdir(POSTS_DIR)

    // Filter for HTML files and sort by numeric prefix
    const htmlFiles = files
      .filter(file => file.endsWith('.html'))
      .sort((a, b) => extractNumericPrefix(a) - extractNumericPrefix(b))

    logger.info('Processing files', { files: htmlFiles })

    // Read content of each file
    const posts: Post[] = await Promise.all(
      htmlFiles.map(async filename => ({
        filename,
        content: await fs.readFile(path.join(POSTS_DIR, filename), 'utf-8')
      }))
    )

    const postsXml = formatXml(posts)

    const prompt = `${BEFORE_DIRECTIVE}

${postsXml}

${AFTER_DIRECTIVE}
`

    await fs.writeFile(OUTPUT_FILE, prompt, 'utf-8')
    console.log(`Successfully combined ${posts.length} posts into ${OUTPUT_FILE}`)

    const tokenCount = countTokens(prompt)
    console.log(`Total token count: ${tokenCount}`)

  } catch (error) {
    console.error('Error processing files:', error)
    process.exit(1)
  }
}

processFiles()
