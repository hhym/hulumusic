import React from 'react'
import {createRoot} from 'react-dom/client'
import './style.css'
import App from './App'

// 任何渲染异常都别留白屏，直接把错误摊在页面上（方便用户截图反馈）
class Boundary extends React.Component<{children: React.ReactNode}, {err: string | null}> {
    state = {err: null as string | null}

    static getDerivedStateFromError(e: any) {
        return {err: (e && (e.stack || e.message)) || String(e)}
    }

    componentDidCatch(e: any, info: React.ErrorInfo) {
        const msg = ((e && (e.stack || e.message)) || String(e)) +
            '\n\n--- 组件栈（出错位置） ---\n' + ((info && info.componentStack) || '(无)')
        this.setState({err: msg})
    }

    render() {
        if (this.state.err) {
            return (
                <div style={{padding: '32px 40px', font: '13px/1.6 ui-monospace,Consolas,monospace', color: '#c0392b'}}>
                    <div style={{fontSize: 16, fontWeight: 600, marginBottom: 12}}>界面加载出错</div>
                    <div style={{whiteSpace: 'pre-wrap', color: '#333'}}>{this.state.err}</div>
                </div>
            )
        }
        return this.props.children
    }
}

const container = document.getElementById('root')

createRoot(container!).render(
    <React.StrictMode>
        <Boundary>
            <App/>
        </Boundary>
    </React.StrictMode>
)
