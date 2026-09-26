const http=require('http'),fs=require('fs'),path=require('path');
const root=__dirname;
http.createServer((req,res)=>{if(req.url==='/results'&&req.method==='POST'){let body='';req.on('data',c=>body+=c);req.on('end',()=>{JSON.parse(body);fs.writeFileSync(path.join(root,'canvas-results.json'),body);res.end('saved')});return;}res.setHeader('Content-Type','text/html');res.end(fs.readFileSync(path.join(root,'canvas-comparison.html')))}).listen(8769,'127.0.0.1',()=>console.log('Benchmark ready on http://127.0.0.1:8769'));
