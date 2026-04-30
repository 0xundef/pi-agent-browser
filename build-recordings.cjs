const fs = require('fs');
const path = require('path');

const templatePath = path.join(__dirname, 'recordings_template.html');
const dataPath = path.join(__dirname, 'recordings.json');
const outputPath = path.join(__dirname, 'recordings.html');

try {
  const template = fs.readFileSync(templatePath, 'utf8');
  const data = fs.readFileSync(dataPath, 'utf8');

  // Inject the JSON directly into the script tag
  const result = template.replace('__RECORDINGS_JSON__', data);
  
  fs.writeFileSync(outputPath, result);
  console.log('✅ Successfully generated recordings.html');
  console.log(`📂 You can view it by opening: file://${outputPath}`);
} catch (err) {
  console.error('❌ Error generating recordings:', err);
}