import { Session, Context, Schema, Logger } from 'koishi'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import { request as httpRequest } from 'http'
import { request as httpsRequest } from 'https'

async function getfileByUrl(url: string, fileName: string, dir: string): Promise<boolean> {
  try {
    const stream = fsSync.createWriteStream(join(dir, fileName));
    return new Promise((resolve, reject) => {
      const request = url.startsWith('https:') ? httpsRequest : httpRequest;
      const req = request(url, (res) => {
        res.pipe(stream);
        res.on('end', () => {
          logger.info("语录" + fileName + "下载完毕");
          resolve(true);
        });
        res.on('error', (err: Error) => {
          logger.error(err);
          reject(err);
        });
      });
      req.on('error', (err: Error) => {
        logger.error(err);
        reject(err);
      });
      req.end();
    })
  } catch (err) {
    logger.error(err)
    return false
  }
}

async function checkFile(path: string): Promise<boolean> {
  try {
    const stats = await fs.stat(path)
    return stats.size >= 100
  } catch (err) {
    logger.error(err)
    return false
  }
}

const logger = new Logger('yulu')

export const name = 'yulu'

export interface Config {
  dataDir: string
  pageSize: number
  maxImageSize: number
  lessRepetition: number
}

export const inject = {
  required: ['database'],
  optional: ['cache'],
}

export const Config: Schema<Config> = Schema.object({
  dataDir: Schema.string().default("./data/yulu"),
  pageSize: Schema.number().default(10),
  lessRepetition: Schema.number().default(80).max(100).min(0),
  maxImageSize: Schema.number().default(1000),
}).i18n({
  'zh-CN': require('./locales/zh-CN'),
})

declare module 'koishi' {
  interface Tables {
    yulu: Yulu
  }
  interface Context {
    cache?: any
  }
}

export interface Yulu {
  id: number
  content: string
  time: Date
  origin_message_id: string
  tags: string
  group: string
}

function sendYulu(y: Yulu, p: string, t: boolean): string {
  let res: string = String(y.id) + ":"
  if (t) {
    res = res + y.tags
  }
  if (y.content.slice(0, 4) == "http" || y.content == "img") {
    const href = pathToFileURL(join(resolve(p), String(y.id))).href
    res = res + `<img src="${href}">`
  } else {
    res = res + y.content
  }
  return res
}

export function apply(ctx: Context, cfg: Config) {
  ctx.model.extend('yulu', {
    id: 'unsigned',
    content: 'string',
    time: 'timestamp',
    origin_message_id: 'string',
    tags: 'text',
    group: 'string'
  }, { autoInc: true })

  ctx.i18n.define('zh-CN', require('./locales/zh-CN'))

function getQuotedId(session: Session): number | null {
  try {
    if (session.quote?.content) {
      const match = session.quote.content.match(/>?(\d+):/);
      if (match) {
        const id = Number(match[1]);
        return Number.isNaN(id) ? null : id;
      }
    }
    return null;
  } catch (err) {
    return null;
  }
}

async function getQuotedYuluId(session: Session, ctx: Context): Promise<number | null> {
  try {
    // 首先尝试从消息内容中解析ID
    const directId = getQuotedId(session);
    if (directId) {
      return directId;
    }

    // 如果无法直接解析，尝试通过引用消息的messageId查找数据库
    if (session.quote?.messageId || session.quote?.id) {
      const messageId = session.quote.messageId || session.quote.id;
      const yuluRecords = await ctx.database.get('yulu', { origin_message_id: messageId });

      if (yuluRecords.length > 0) {
        const yuluId = yuluRecords[0].id;
        return yuluId;
      }
    }

    return null;
  } catch (err) {
    logger.error('[getQuotedYuluId] 查找语录ID时出错:', err);
    return null;
  }
}

  try {
    if (!fsSync.existsSync(cfg.dataDir)) {
      fsSync.mkdirSync(cfg.dataDir)
    }
  } catch (err) {
    logger.error(err)
    logger.error("请检查文件权限")
  }

  let listeningQueue: Array<{ stat: string, group: string, user: string, content: { time: Date, origin_message_id: string, group: string, tags: string } }> = []

  function rmErrYulu(id: number, session: Session) {
    session.send(session.text('.download-failed', [id]))
    session.execute(`yulu_select -i ${id} -l`)
    logger.warn(`语录${id}文件异常，从数据库移除`)
    setTimeout(() => {
      ctx.database.remove('yulu', [id])
      session.send(session.text('.delete-finish', [id]))
    }, 1000)
  }

  ctx.command('yulu/yulu_remove [...rest]').alias("删除语录")
    .option('id', '-i <id:number>')
    .action(async ({ session, options }) => {
      const removeYulu = async (id: number) => {
        const finds = await ctx.database.get('yulu', id)
        if (finds.length == 0) {
          return session.text('.no-result')
        }

        // 删除对应的图片文件
        try {
          const filePath = join(cfg.dataDir, String(id))
          if (fsSync.existsSync(filePath)) {
            fsSync.unlinkSync(filePath)
          }
        } catch (err) {
          logger.warn(`删除语录${id}的文件时出错:`, err)
        }

        try {
          await ctx.database.remove('yulu', [id])
          return session.text('.remove-succeed')
        } catch (err) {
          logger.error(`数据库删除失败:`, err)
          return `删除语录失败: ${err.message}`
        }
      }

      if (options.id) {
        return await removeYulu(options.id)
      } else {
        const quotedId = await getQuotedYuluId(session, ctx);
        if (quotedId) {
          return await removeYulu(quotedId)
        } else {
          return "请引用要删除的语录消息，或使用 -i 参数指定语录ID\n例如：yulu_remove -i 123"
        }
      }
    })

  ctx.command('yulu/yulu_add [...rest]').alias("添加语录")
    .action(async ({ session }, ...rest) => {
      for (let listen of listeningQueue) {
        if (((!session.guildId && listen.group == session.event.user.id) || session.guildId == listen.group) && session.event.user.id == listen.user && listen.stat == "pending") {
          return session.text(".pic-in-process")
        }
        if (((!session.guildId && listen.group == session.event.user.id) || session.guildId == listen.group) && session.event.user.id == listen.user) {
          return session.text(".still-in-progress")
        }
      }
      const tags = []
      let group: string
      if (session.guildId) {
        group = session.guildId
      } else {
        group = session.userId
      }
      tags.push(group)
      for (let i = 0; i < rest.length; i++) {
        tags.push(rest[i])
      }
      const tag_str = JSON.stringify(tags)
      const cont = { time: new Date(), origin_message_id: session.event.message.id, group: group, tags: tag_str }
      listeningQueue.push({ stat: "wait", group: group, user: session.event.user.id, content: cont })
      return session.text('.wait-pic')
    })

  ctx.command('yulu/yulu_tag_add [...rest]').alias("addtag")
    .action(async ({ session }, ...rest) => {
      if (rest.length < 1) {
        return session.text('.no-tag-to-add')
      } else {
        if (session.quote || session.elements[0].type == "quote") {
          let target: number
          try {
            target = Number(session.quote.content.match(/>?(\d+):/)[1])
            if (Number.isNaN(target)) {
              throw new Error()
            }
          } catch {
            return session.text('.no-mes-quoted')
          }
          if (Number.isNaN(target)) {
            return session.text('.no-mes-quoted')
          }
          let exist = await ctx.database.get('yulu', { id: target, })
          if (exist.length > 0) {
            let count = 0
            const target = exist[0].id
            let tags = JSON.parse(exist[0].tags)
            for (let i = 0; i < rest.length; i++) {
              if (!tags.includes(rest[i])) {
                tags.push(rest[i])
                count++
              }
            }
            const tag_str = JSON.stringify(tags)
            ctx.database.set('yulu', target, { tags: tag_str })
            return session.text('.add-succeed', [count])
          } else {
            return session.text('.not-found', [target])
          }
        } else {
          return session.text('.no-mes-quoted')
        }
      }
    })

  ctx.command('yulu/yulu_tag_remove [...rest]').alias("rmtag")
    .action(async ({ session }, ...rest) => {
      if (rest.length === 0) {
        return session.text('.no-tag-to-remove')
      } else {
        if (session.quote || session.elements[0].type == "quote") {
          let target: number
          try {
            target = Number(session.quote.content.match(/>?(\d+):/)[1])
            if (Number.isNaN(target)) {
              throw new Error()
            }
          } catch {
            return session.text('.no-mes-quoted')
          }
          if (Number.isNaN(target)) {
            return session.text('.no-mes-quoted')
          }
          let exist = await ctx.database.get('yulu', { id: target, })
          if (exist.length > 0) {
            let count = 0
            const target = exist[0].id
            let tags: string[] = JSON.parse(exist[0].tags)
            tags = tags.filter(tag => { //去除tags中所有在rest中的项
              if (rest.includes(tag)) {
                count++
                return false
              }
              return true
            })
            const tag_str = JSON.stringify(tags)
            ctx.database.set('yulu', target, { tags: tag_str })
            return session.text('.remove-succeed', [count])
          } else {
            return session.text('.not-found', [target])
          }
        } else {
          return session.text('.no-mes-quoted')
        }
      }
    })

  ctx.command('yulu/yulu_select [...rest]').alias("语录")
    .option('id', '-i <id:number>')
    .option('global', '-g')
    .option('tag', '-t')
    .option('list', '-l').option('page', '-p <page:number>').option('full', '-f')
    .shortcut('引用语录', { fuzzy: true, options: { global: true } })
    .action(async ({ session, options }, ...rest) => {
      let finds: Yulu[]
      if (options.id) {
        finds = await ctx.database.get('yulu', options.id)
        if (finds.length == 0) {
          return session.text('.no-result')
        }
        const y = finds[0]
        if (options.list) {
          const res = String(y.id) + ":" + y.tags + "\n"
          return res
        } else {
          if (!await checkFile(join(cfg.dataDir, String(options.id)))) {//语录文件下载失败
            rmErrYulu(options.id, session)
            return
          }
          return sendYulu(y, cfg.dataDir, options.tag)
        }
      } else {
        let group: string
        if (session.guildId) {
          group = session.guildId
        } else {
          group = session.userId
        }
        let query = ctx.database.select('yulu')
        if (!options.global) {
          query.where({ group: { $eq: group } })
        }
        for (let i = 0; i < rest.length; i++) {
          query.where({ tags: { $regex: rest[i] } })
        }
        finds = await query.execute()
        if (finds.length == 0) {
          return session.text('.no-result')
        }
        if (!options.list) {
          let find: Yulu
          for (let i = 0; i < 10; i++) {
            find = finds[Math.floor(Math.random() * finds.length)];
            if (ctx.cache && await ctx.cache.get(`yulu_recent_send_${session.guildId}`, String(find.id))) {
              if (Math.random() * 100 > cfg.lessRepetition) {
                break
              }
            } else {
              break
            }
          }
          if (!await checkFile(join(cfg.dataDir, String(find.id)))) {//语录文件下载失败
            rmErrYulu(find.id, session)
            return
          }
          const res = sendYulu(find, cfg.dataDir, options.tag)
          if (ctx.cache) {
            await ctx.cache.set(`yulu_recent_send_${session.guildId}`, String(find.id), true, 1000 * 500)
          }
          return res
        } else {
          let page: number
          if (!options.page) {
            page = 1
          } else {
            page = options.page
          }
          let res: string = ""
          let i = 0;
          for (i = page * cfg.pageSize - cfg.pageSize; (i < page * cfg.pageSize || options.full) && i < finds.length; i++) {
            const y = finds[i]
            res += String(y.id) + ":" + y.tags + "\n"
          }
          if (i < finds.length) {
            res += session.text('.rest', [page, Math.ceil(finds.length / cfg.pageSize)])
          }
          return res
        }
      }
    })

  ctx.middleware(async (session, next) => {
    for (let i = 0; i < session.elements.length; i++) {
      if (session.elements[i].type == "quote") {
        session.execute(session.content.slice(session.content.lastIndexOf('>') + 1))
        break
      }
    }
    if (listeningQueue.length > 0) {
      for (let listen of listeningQueue) {
        if (((!session.guildId && listen.group == session.event.user.id) || session.guildId == listen.group) && session.event.user.id == listen.user && listen.stat == "wait") {
          if (session.event.message.elements[0].type == "img") {
            listen.stat = "pending"
            const item = listen.content;
            const src = session.event.message.elements[0].attrs.src
            const res = await ctx.database.create('yulu', { content: src, time: item.time, origin_message_id: item.origin_message_id, tags: item.tags, group: item.group })
            await getfileByUrl(src, String(res.id), cfg.dataDir)//下载图片到本地路径
            if (!await checkFile(join(cfg.dataDir, String(res.id)))) {//语录文件下载失败
              logger.warn(`语录${src}下载失败`)
              async function retry(ms: number) {
                return new Promise((resolve, reject) => {
                  setTimeout(async () => {
                    await getfileByUrl(src, String(res.id), cfg.dataDir)
                    resolve(await checkFile(join(cfg.dataDir, String(res.id))))
                  }, ms)
                })
              }
              let flag = false;
              for (let i = 0; i < 10; i++) {
                logger.info(`下载失败，第${i + 1}次重试`)
                if (await retry(2000)) {
                  flag = true
                  logger.info(`下载成功`)
                  break
                }
              }
              if (!flag) {
                logger.info(`重试次数达上限`)
                rmErrYulu(res.id, session)
                return
              }
            }
            const file = join(cfg.dataDir, String(res.id))
            const stats = fsSync.statSync(file)
            if (stats.size > cfg.maxImageSize * 1024) {
              //delete file
              fsSync.unlinkSync(file)
              logger.warn(`语录${res.id}文件过大，从数据库移除`)
              session.send(session.text('file-too-large', [res.id]))
              ctx.database.remove('yulu', [res.id])
              return
            }
            //OCR
            await ctx.database.set('yulu', res.id, { origin_message_id: session.event.message.id })
            session.send(session.text("add-succeed", [res.id]))
            listen.stat = "finished";
            break
          } else if (session.event.message.content == "取消") {
            listen.stat = "finished";
            break
          }
        }
      }    listeningQueue = listeningQueue.filter((item) => { return item.stat != "finished" })
  }

  const debugMode = false

  return next()
  })
}
