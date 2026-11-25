export const enterpriseTheme = {
  token: {
    colorPrimary: '#3159b8',
    colorInfo: '#3159b8',
    colorSuccess: '#268064',
    colorWarning: '#b57c20',
    colorError: '#c94b50',
    colorText: '#1c293c',
    colorTextSecondary: '#748095',
    colorBorder: '#dce2eb',
    colorBorderSecondary: '#e9edf3',
    colorBgLayout: '#f4f6fa',
    colorFillAlter: '#f7f9fc',
    fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif',
    fontSize: 13,
    borderRadius: 8,
    controlHeight: 36,
    controlHeightSM: 28,
    boxShadowSecondary: '0 12px 40px rgba(19, 35, 64, 0.12)',
    motionDurationMid: '0.15s'
  },
  components: {
    Layout: { headerBg:'#ffffff', siderBg:'#142237', triggerBg:'#101c2e', headerHeight:64 },
    Menu: {
      darkItemBg:'transparent', darkSubMenuItemBg:'transparent',
      darkItemColor:'#a5b3c7', darkItemHoverBg:'#1d304d', darkItemHoverColor:'#ffffff',
      darkItemSelectedBg:'#263f66', darkItemSelectedColor:'#ffffff',
      darkGroupTitleColor:'#657c99', itemHeight:42, itemBorderRadius:7, iconSize:16
    },
    Card: { headerFontSize:14, headerHeight:54, bodyPadding:22 },
    Table: {
      headerBg:'#f7f9fc', headerColor:'#66748a', headerSplitColor:'transparent',
      borderColor:'#edf0f5', rowHoverBg:'#f5f8fe',
      cellPaddingBlock:14, cellPaddingInline:16,
      cellPaddingBlockSM:11, cellPaddingInlineSM:12, fontSize:13
    },
    Button: { primaryShadow:'none', defaultShadow:'none', fontWeight:500 },
    Tag: { defaultBg:'#f1f4f8', defaultColor:'#5c6c82' },
    Statistic: { contentFontSize:30, titleFontSize:12 },
    Modal: { titleFontSize:17 },
    Input: { activeShadow:'0 0 0 3px rgba(49,89,184,.08)' },
    Select: { optionSelectedBg:'#eef3fe' }
  }
};
