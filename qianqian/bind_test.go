package qianqian

import (
	"reflect"
	"testing"
)

// mygo 的绑定规则很硬：方法有两个返回值时，第二个必须是 error，否则一启动就弹
// 「mygo: App.XXX: the second result must be an error」。这条以前踩过两次
// （PluginMarket、MarketDir 各一次），用反射一次性守住 API 里的所有方法。
func TestAPIReturnSignatures(t *testing.T) {
	errType := reflect.TypeOf((*error)(nil)).Elem()
	typ := reflect.TypeOf(API{})
	for i := 0; i < typ.NumMethod(); i++ {
		m := typ.Method(i)
		ft := m.Type
		switch ft.NumOut() {
		case 0, 1:
			// 单返回值：要么是值，要么是 error，都合法
		case 2:
			if ft.Out(1) != errType {
				t.Fatalf("API.%s 的第二个返回值必须是 error，当前是 %v", m.Name, ft.Out(1))
			}
		default:
			t.Fatalf("API.%s 返回值太多：%d 个（mygo 只允许一个值加一个 error）", m.Name, ft.NumOut())
		}
	}
}
