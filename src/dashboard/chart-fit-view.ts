/**
 * The browser code that draws a chart as wide as its box, so its text keeps its size and it never scrolls: a chart svg
 * carries `data-chart="<key>"` and is drawn `chartWidth(key)` wide. `fitCharts()`, after each render and resize,
 * measures every chart of the page and renders again when one was drawn at another width. Until the page has measured
 * a box, the window's width guesses it. The dashboard client embeds this code before its pages, and so supplies
 * `render`.
 */
export const chartFitView = `
const chartWidths={};
const chartWidth=(key,wide=760)=>chartWidths[key]||(window.innerWidth<700?440:window.innerWidth>=1300?wide:760);
function fitCharts(){
 const charts=[...document.querySelectorAll('#view svg[data-chart]')].map(svg=>({key:svg.dataset.chart,drawn:svg.viewBox.baseVal.width,box:Math.round(svg.getBoundingClientRect().width)})).filter(c=>c.box>0).map(c=>({...c,box:Math.max(320,c.box)}));
 if(!charts.some(c=>Math.abs(c.box-c.drawn)>2))return;
 for(const c of charts)chartWidths[c.key]=c.box;
 render();
}
`;
