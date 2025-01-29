import { promises as fs } from 'fs'
import path from 'path'
import { encoding_for_model } from '@dqbd/tiktoken'

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

const processFiles = async (): Promise<void> => {
  try {
    // Read all files from posts directory
    const files = await fs.readdir(POSTS_DIR)

    // Filter for HTML files and sort by numeric prefix
    const htmlFiles = files
      .filter(file => file.endsWith('.html'))
      .sort((a, b) => extractNumericPrefix(a) - extractNumericPrefix(b))

    // Read content of each file
    const posts: Post[] = await Promise.all(
      htmlFiles.map(async filename => ({
        filename,
        content: await fs.readFile(path.join(POSTS_DIR, filename), 'utf-8')
      }))
    )

    const postsXml = `<posts>
${posts.map(post => `<post filename="${post.filename}">\n${post.content}\n</post>`).join('\n\n')}
</posts>`

    const prompt = `${BEFORE_DIRECTIVE}

${postsXml}

${AFTER_DIRECTIVE}
`

    // Write to output file
    await fs.writeFile(OUTPUT_FILE, prompt, 'utf-8')
    console.log(`Successfully combined ${posts.length} posts into ${OUTPUT_FILE}`)

    // Get token count
    const tokenCount = countTokens(prompt)
    console.log(`Total token count: ${tokenCount}`)

  } catch (error) {
    console.error('Error processing files:', error)
    process.exit(1)
  }
}

processFiles()
