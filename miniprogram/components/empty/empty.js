Component({
  options: { addGlobalClass: true },
  properties: {
    /** 空状态主文案 */
    text: { type: String, value: '这里空空如也' },
    /** 副文案 */
    tip: { type: String, value: '' },
    /** 图标形态：box | chat | order | search | net */
    icon: { type: String, value: 'box' },
    /** 操作按钮文案（可选） */
    action: { type: String, value: '' }
  },
  methods: {
    onAction() { this.triggerEvent('action'); }
  }
});
