import {useMemo} from 'react'
import qrcode from 'qrcode-generator'

/* 插件扫码登录的弹窗。

   插件的 signIn() 里调 host.signInPrompt({qr, text})，mygoRuntime 把它转成
   mygo-signin-prompt 事件，这里负责把二维码内容和提示画出来。

   不是每次调用都带二维码：有的插件登录成功后会再提示一句 "Signed in"，
   这时 qr 是空的。以前那会被当成「二维码解析失败」，看着像出错，其实已经登录了。
   所以这里分三种情况：能画二维码就画，是图片地址就直接显示，只剩文字就只显示文字。 */

export type SignInRequest = {qr: string; text: string; pluginId?: string; done: () => void}

const SUCCESS_RE = /signed in|登录成功|已登录|登陆成功|success|logged in/i

function classifyQr(qr: string): 'content' | 'image' | 'empty' {
  const v = (qr || '').trim()
  if (!v) return 'empty'
  if (/^data:image\//i.test(v)) return 'image'
  if (/^https?:\/\/.+\.(png|jpg|jpeg|gif|webp|bmp)(\?.*)?$/i.test(v)) return 'image'
  return 'content'
}

export default function SignInModal({req, onClose}: {req: SignInRequest; onClose: () => void}) {
  const kind = classifyQr(req.qr)
  const ok = kind === 'empty' && SUCCESS_RE.test(req.text || '')

  const img = useMemo(() => {
    if (kind !== 'content') return ''
    try {
      const q = qrcode(0, 'M')
      q.addData(req.qr.trim())
      q.make()
      return q.createDataURL(8, 2)
    } catch {
      return ''
    }
  }, [req.qr, kind])

  function finish() {
    req.done()
    onClose()
  }

  return (
    <div className="mask" onClick={finish}>
      <div className="qr-card" onClick={(e) => e.stopPropagation()}>
        <h4 className={ok ? 'qr-title ok' : 'qr-title'}>{ok ? '登录成功' : '扫码登录'}</h4>
        {req.pluginId && <p className="qr-from">{req.pluginId}</p>}
        {req.text && <p className="qr-tip">{req.text}</p>}

        {img ? <img className="qr-img" src={img} alt="登录二维码" /> : null}
        {kind === 'image' ? <img className="qr-img" src={req.qr} alt="登录二维码" /> : null}
        {kind === 'content' && !img ? (
          <div className="qr-fallback">
            这段内容画不成二维码，可能是插件给的数据格式不对。
            <code>{req.qr.slice(0, 80)}</code>
          </div>
        ) : null}

        <div className="qr-ops">
          <button className="ghost-btn" onClick={finish}>关闭</button>
        </div>
      </div>
    </div>
  )
}
