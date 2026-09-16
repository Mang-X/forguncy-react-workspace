// 宿主 React 桩：仅供本地烟雾测试注入 vm 沙箱使用，不进入任何交付物。
// 模拟 ReactCellType 运行时提供的 globalThis.React / ReactDOM。
// react-query 在模块求值阶段就会调用 React.createContext，
// 因此桩必须在 bundle 执行前存在，否则 bundle 会（按设计）拒绝加载。
export default function injectHostReact(sandbox) {
  if (sandbox.React) return sandbox;

  const React = {
    version: "19.0.0",
    Fragment: Symbol.for("react.fragment"),
    createElement(type, props, ...children) {
      return { $$typeof: Symbol.for("react.element"), type, props: props || {}, children };
    },
    createContext(defaultValue) {
      const context = {
        $$typeof: Symbol.for("react.context"),
        _currentValue: defaultValue,
        Provider: null,
        Consumer: null,
        displayName: undefined
      };
      context.Provider = { $$typeof: Symbol.for("react.provider"), _context: context };
      context.Consumer = { $$typeof: Symbol.for("react.consumer"), _context: context };
      return context;
    },
    useState(initial) {
      return [typeof initial === "function" ? initial() : initial, () => {}];
    },
    useEffect() {},
    useLayoutEffect() {},
    useRef(value) {
      return { current: value };
    },
    useCallback(fn) {
      return fn;
    },
    useMemo(fn) {
      return fn();
    },
    useContext(context) {
      return context._currentValue;
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot();
    },
    useDebugValue() {},
    useId() {
      return "react-stub-id";
    },
    memo(component) {
      return component;
    },
    forwardRef(component) {
      return component;
    },
    Children: { map: (children, fn) => fn(children), toArray: children => [children].filter(Boolean) },
    Component: class Component {},
    PureComponent: class PureComponent {},
    cloneElement(element, props) {
      return Object.assign({}, element, { props: Object.assign({}, element.props, props) });
    },
    isValidElement(value) {
      return Boolean(value && value.$$typeof === Symbol.for("react.element"));
    }
  };

  sandbox.React = React;
  sandbox.ReactDOM = {
    version: "19.0.0",
    createRoot() {
      return { render() {}, unmount() {} };
    },
    flushSync(callback) {
      return callback();
    }
  };
  return sandbox;
}
