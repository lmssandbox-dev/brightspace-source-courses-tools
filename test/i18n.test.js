'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {translate,translateReport,normalizeLanguage,catalogs}=require('../src/ui/i18n');
test('all supported languages have matching catalogs and template parameters',()=>{
 for(const lang of ['es-419','pt-BR']){
  assert.deepEqual(Object.keys(catalogs[lang]),Object.keys(catalogs.en));
  for(const [key,value] of Object.entries(catalogs[lang])){
   assert.ok(value.trim());assert.deepEqual(value.match(/\{\d+\}/g),key.match(/\{\d+\}/g));
  }
 }
 assert.equal(normalizeLanguage('__proto__'),'en');assert.equal(normalizeLanguage('fr'),'en');
});
test('dynamic summaries preserve IDs, counts, and whitespace across languages',()=>{
 assert.equal(translate(' All 2 replicas were copied successfully and are active. ','pt-BR'),' Todas as 2 réplicas foram copiadas com sucesso e estão ativas. ');
 assert.equal(translate('Last check: 10 of 5000 replicas checked.','es-419'),'Última verificación: 10 de 5000 réplicas verificadas.');
 assert.equal(translate('Course unavailable or inaccessible (HTTP 403).','pt-BR'),'Curso indisponível ou inacessível (HTTP 403).');
 assert.equal(translate('Tenant course name 9532','pt-BR'),'Tenant course name 9532');
 assert.equal(translate('Review & Confirm','unknown'),'Review & Confirm');
});
test('Source Course recheck guidance and update time are translated in all supported languages',()=>{
 const timestamp='13 Oct 2026, 14:05 UTC',updated=`Source Course information is current through ${timestamp}.`;
 assert.equal(translate(updated,'es-419'),`La información de los cursos de origen está actualizada hasta el ${timestamp}.`);
 assert.equal(translate('If you created or changed Source Courses in Brightspace after this time, select the option below.','pt-BR'),'Se você criou ou alterou cursos de origem no Brightspace depois desse horário, selecione a opção abaixo.');
 assert.equal(translate('Check Brightspace for recent changes (may take a little longer).','pt-BR'),'Verificar alterações recentes no Brightspace (pode levar um pouco mais de tempo).');
 assert.equal(translate('Check Brightspace for recent changes (may take a little longer).','es-419'),'Buscar cambios recientes en Brightspace (puede tardar un poco más).');
 assert.equal(translate('Brightspace information updated through','pt-BR'),'Informações do Brightspace atualizadas até');
 assert.equal(translate('Update date unavailable','es-419'),'Fecha de actualización no disponible');
 assert.equal(translate('This is the date of the latest Brightspace information available to the app. Changes made afterward may not appear yet.','pt-BR'),'Esta é a data das informações mais recentes do Brightspace disponíveis no app. Alterações posteriores talvez ainda não apareçam.');
});
test('report translation changes headings only and preserves CSV body byte for byte',()=>{
 const csv='\uFEFF"Source ID","Replica name","Copy logs"\r\n"9532","Status","Todos os dados copiados com êxito\r\n<example>"';
 const result=translateReport(csv,'es-419');
 assert.ok(result.startsWith('\uFEFF"ID de origen","Nombre de réplica","Registros de copia"'));
 assert.equal(result.slice(result.indexOf('\r\n')),csv.slice(csv.indexOf('\r\n')));
 assert.equal(translateReport(csv,'en'),csv);
});
