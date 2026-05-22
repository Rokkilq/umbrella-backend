const express = require('express')
const axios = require('axios')
const cron = require('node-cron')
const cors = require('cors')

const app = express()
app.use(cors())
app.use(express.json())

// ==================== 配置区域 ====================
// 请填入你的配置信息
const CONFIG = {
  // 微信小程序配置
  WX_APPID: 'wxdfd67865679ea59e',           // 小程序AppID
  WX_APPSECRET: 'a32e7f3d1af8e21f239bb8f171ec104e',  // 小程序AppSecret
  
  // 微信订阅消息模板ID (在微信后台获取)
  WX_TEMPLATE_ID: 'DClxAsw9x3HkphzahUubb4L-fECeWW_jucHtYLdsLe4',  // 已配置
  
  // 和风天气API Key (免费注册: https://dev.heweather.com/)
  HEWEATHER_KEY: '45f12eeef82e429981bd6d9be5bb92dc',  // 已配置
  
  // 推送城市
  PUSH_LOCATION: '黄岛',                      // 青岛市黄岛区
  PUSH_ADCODE: '370211'                      // 黄岛区行政编码
}

// ==================== 数据存储 ====================
// 模拟数据库 - 用户订阅信息
const users = new Map()

// ==================== 微信API ====================

// 获取openid
app.post('/api/get-openid', async (req, res) => {
  try {
    const { code } = req.body
    
    const response = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
      params: {
        appid: CONFIG.WX_APPID,
        secret: CONFIG.WX_APPSECRET,
        js_code: code,
        grant_type: 'authorization_code'
      }
    })

    if (response.data.openid) {
      res.json({ success: true, openid: response.data.openid })
    } else {
      res.json({ success: false, error: response.data.errmsg })
    }
  } catch (err) {
    console.error('获取openid失败', err.message)
    res.json({ success: false, error: err.message })
  }
})

// 订阅接口
app.post('/api/subscribe', async (req, res) => {
  try {
    const { openid, location = CONFIG.PUSH_LOCATION } = req.body
    
    users.set(openid, {
      openid,
      location,
      subscribedAt: new Date().toISOString()
    })

    console.log(`✅ 用户订阅成功: ${openid} (${location})`)
    res.json({ success: true })
  } catch (err) {
    console.error('订阅失败', err.message)
    res.json({ success: false, error: err.message })
  }
})

// 取消订阅接口
app.post('/api/unsubscribe', async (req, res) => {
  try {
    const { openid } = req.body
    
    if (users.has(openid)) {
      users.delete(openid)
      console.log(`❌ 用户取消订阅: ${openid}`)
    }

    res.json({ success: true })
  } catch (err) {
    res.json({ success: false, error: err.message })
  }
})

// 获取当前天气
app.get('/api/weather', async (req, res) => {
  try {
    const location = req.query.location || CONFIG.PUSH_LOCATION
    
    // 获取实时天气
    const weatherRes = await axios.get('https://devapi.qweather.com/v7/weather/now', {
      params: {
        key: CONFIG.HEWEATHER_KEY,
        location: CONFIG.PUSH_ADCODE,
        lang: 'zh'
      }
    })

    // 获取预报天气 (用于判断明天是否下雨)
    const forecastRes = await axios.get('https://devapi.qweather.com/v7/weather/3d', {
      params: {
        key: CONFIG.HEWEATHER_KEY,
        location: CONFIG.PUSH_ADCODE,
        lang: 'zh'
      }
    })

    const nowData = weatherRes.data.now
    const forecastData = forecastRes.data.daily

    // 判断是否需要带伞
    const willRain = forecastData.some(day => {
      // 判断明天和后天是否有雨
      const tomorrow = new Date()
      tomorrow.setDate(tomorrow.getDate() + 1)
      const dateStr = tomorrow.toISOString().split('T')[0]
      return day.date === dateStr && ['Rain', 'Snow', 'Sleet'].includes(day.textDay)
    })

    const emoji = willRain ? '🌧️' : '☀️'
    const temp = `${nowData.temp}°C`
    const desc = nowData.text

    res.json({
      success: true,
      weather: {
        emoji,
        temp,
        desc,
        rain: willRain
      }
    })
  } catch (err) {
    console.error('获取天气失败', err.message)
    // 返回默认数据
    res.json({
      success: false,
      weather: {
        emoji: '☀️',
        temp: '--°C',
        desc: '天气数据获取失败',
        rain: false
      }
    })
  }
})

// 发送订阅消息
async function sendSubscribeMessage(openid, weather) {
  try {
    // 获取 access_token
    const tokenRes = await axios.get('https://api.weixin.qq.com/cgi-bin/token', {
      params: {
        grant_type: 'client_credential',
        appid: CONFIG.WX_APPID,
        secret: CONFIG.WX_APPSECRET
      }
    })

    const accessToken = tokenRes.data.access_token

    // 构造消息内容
    const message = {
      touser: openid,
      template_id: CONFIG.WX_TEMPLATE_ID,
      page: 'pages/index/index',
      data: {
        date6: { value: new Date().toLocaleDateString('zh-CN') },
        weather1: { value: weather.desc },
        degree2: { value: weather.temp },
        phrase4: { value: weather.rain ? '记得带伞！🌧️' : '不用带伞 ☀️' }
      }
    }

    // 发送消息
    const sendRes = await axios.post(
      `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${accessToken}`,
      message
    )

    console.log(`📤 消息发送结果: ${JSON.stringify(sendRes.data)}`)
    return sendRes.data

  } catch (err) {
    console.error('发送订阅消息失败', err.message)
    throw err
  }
}

// ==================== 定时推送任务 ====================

// 每天晚上 22:00 执行
cron.schedule('0 22 * * *', async () => {
  console.log('⏰ 开始执行每日天气推送任务...')
  
  try {
    // 获取天气预报
    const forecastRes = await axios.get('https://devapi.qweather.com/v7/weather/3d', {
      params: {
        key: CONFIG.HEWEATHER_KEY,
        location: CONFIG.PUSH_ADCODE,
        lang: 'zh'
      }
    })

    // 获取实时天气
    const nowRes = await axios.get('https://devapi.qweather.com/v7/weather/now', {
      params: {
        key: CONFIG.HEWEATHER_KEY,
        location: CONFIG.PUSH_ADCODE,
        lang: 'zh'
      }
    })

    const tomorrow = forecastRes.data.daily[1] // 明天的预报
    const now = nowRes.data.now

    // 判断是否下雨
    const willRain = ['Rain', 'Snow', 'Sleet', 'Heavy Rain', 'Heavy Snow'].includes(tomorrow.textDay) ||
                     parseInt(tomorrow.precip) > 30

    const weather = {
      desc: `${tomorrow.textDay} ${tomorrow.tempMin}°C ~ ${tomorrow.tempMax}°C`,
      temp: `${now.temp}°C`,
      rain: willRain
    }

    console.log(`📊 天气情况: ${weather.desc}, 需要带伞: ${willRain}`)

    // 推送给所有订阅用户
    let successCount = 0
    let failCount = 0

    for (const [openid, user] of users.entries()) {
      try {
        await sendSubscribeMessage(openid, weather)
        successCount++
      } catch (err) {
        failCount++
        console.error(`❌ 推送失败 ${openid}: ${err.message}`)
      }
    }

    console.log(`✅ 推送完成: 成功 ${successCount} 人, 失败 ${failCount} 人`)

  } catch (err) {
    console.error('❌ 定时推送任务失败', err.message)
  }
})

// ==================== 健康检查 ====================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    users: users.size
  })
})

// ==================== 启动服务 ====================

const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════╗
║           ☂️ 带伞提醒后端服务已启动                  ║
╠════════════════════════════════════════════════════╣
║  服务端口: ${PORT}                                   ║
║  推送时间: 每天晚上 22:00                            ║
║  推送城市: ${CONFIG.PUSH_LOCATION}                          ║
║  订阅用户: 0 人                                     ║
╚════════════════════════════════════════════════════╝

  ⚠️  请确保已完成以下配置:
  1. 和风天气 API Key
  2. 微信订阅消息模板 ID

  📝  后续步骤:
  1. 部署到 Railway/Render/腾讯云
  2. 在微信小程序后台配置服务器域名
  3. 添加订阅消息模板
  4. 更新 miniprogram/app.js 中的 backendUrl
`)
})
