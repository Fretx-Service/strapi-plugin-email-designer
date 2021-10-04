'use strict';

/**
 * email-designer.js email service
 */

const _ = require('lodash');
const isValidEmail = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
const decode = require('decode-html');
const { htmlToText } = require('html-to-text');
const mailjet = require ('node-mailjet');

/**
 * fill subject, text and html using lodash template
 * @param {object} emailOptions - to, from and replyto...
 * @param {object} emailTemplate - object containing attributes to fill
 * @param {object} data - data used to fill the template
 * @returns {{ subject, text, subject }}
 */
const sendTemplatedEmail = async (emailOptions = {}, emailTemplate = {}, data = {}) => {
  Object.entries(emailOptions).forEach(([key, address]) => {
    if (Array.isArray(address)) {
      address.forEach((email) => {
        if (!isValidEmail.test(email)) throw new Error(`Invalid "${key}" email address with value "${email}"`);
      });
    } else {
      if (!isValidEmail.test(address)) throw new Error(`Invalid "${key}" email address with value "${address}"`);
    }
  });

  const requiredAttributes = ['templateName', 'subject'];
  const attributes = [...requiredAttributes, 'text', 'html'];
  const missingAttributes = _.difference(requiredAttributes, Object.keys(emailTemplate));
  if (missingAttributes.length > 0) {
    throw new Error(`Following attributes are missing from your email template : ${missingAttributes.join(', ')}`);
  }

  let queryT = {};
  if(emailTemplate.templateId){
    queryT = { id: emailTemplate.templateId };
  }else if( emailTemplate.templateName){
    queryT = { name: emailTemplate.templateName };
  }

  let { bodyHtml, bodyText } = await strapi
  .query('email-template', 'email-designer')
  .findOne(queryT);

  if ((!bodyText || !bodyText.length) && bodyHtml && bodyHtml.length)
    bodyText = htmlToText(bodyHtml, { wordwrap: 130, trimEmptyLines: true });

  emailTemplate = {
    ...emailTemplate,
    html: decode(bodyHtml),
    text: decode(bodyText),
  };

  const templatedAttributes = attributes.reduce(
    (compiled, attribute) =>
      emailTemplate[attribute]
        ? Object.assign(compiled, { [attribute]: _.template(emailTemplate[attribute])(data) })
        : compiled,
    {}
  );

  return strapi.plugins.email.provider.send({ ...emailOptions, ...templatedAttributes });
};

/**
 * Just support mailjet provider !
 * fill subject, text and html using lodash template
 * @param {object} emailTemplate - object containing attributes to fill
 * @param {array} data - data used to fill the template. data.emailOptions.to is required.(optional emailOptions itens: from and replyto...)
 * @returns {{ response }}
 */
const sendBulkTemplatedEmail = async (emailTemplate = {}, data = []) => {
  if (_.isEmpty(data) || _.isEmpty(emailTemplate)) throw new Error('Invalid parameters!');
  const requiredAttributes = ['templateName', 'subject'];
  const attributes = [...requiredAttributes, 'text', 'html'];
  const missingAttributes = _.difference(requiredAttributes, Object.keys(emailTemplate));
  if (missingAttributes.length > 0) {
    throw new Error(`Following attributes are missing from your email template : ${missingAttributes.join(', ')}`);
  }

  let queryT = {};
  if(emailTemplate.templateId){
    queryT = { id: emailTemplate.templateId };
  }else if( emailTemplate.templateName){
    queryT = { name: emailTemplate.templateName };
  }

  let { bodyHtml, bodyText, externalId, profile } = await strapi
  .query('email-template', 'email-designer')
  .findOne(queryT);
  externalId = _.parseInt(externalId);
  const emailSettings = (_.isEmpty(profile))
    ? strapi.config.get('plugins.templatedEmail.default','')
    : strapi.config.get(`plugins.templatedEmail.${profile}`,'');
  if(emailSettings.provider !== 'mailjet') throw new Error(`Provider "${emailSettings.provider}" not supported!`);

  if ((!bodyText || !bodyText.length) && bodyHtml && bodyHtml.length)
    bodyText = htmlToText(bodyHtml, { wordwrap: 130, trimEmptyLines: true });

  let messages = [];
  data.forEach(item => {
    const { emailOptions } = item;
    Object.entries(emailOptions).forEach(([key, address]) => {
      if (Array.isArray(address)) {
        address.forEach((email) => {
          if (!isValidEmail.test(email)) throw new Error(`Invalid "${key}" email address with value "${email}"`);
        });
      } else {
        if (!isValidEmail.test(address)) throw new Error(`Invalid "${key}" email address with value "${address}"`);
      }
    });

    // in case of externalId, uses it, else proccess local template
    if(externalId > 0) {
      messages.push({
        "From": {
          "Email": emailSettings.settings.defaultFrom,
          "Name": emailSettings.settings.defaultFromName
        },
        "To": [
          {
            "Email": emailOptions.to,
            "Name": ""
          }
        ],
        "Subject": emailTemplate.subject,
        "TemplateID": externalId,
        "TemplateLanguage": true,
        "Variables": {
          "data" : { ...item }
        }
      })
    } else {
      let contentTemplate = {
        html: decode(bodyHtml),
        text: decode(bodyText),
      };
      const templatedAttributes = attributes.reduce(
        (compiled, attribute) =>
        contentTemplate[attribute]
            ? Object.assign(compiled, { [attribute]: _.template(contentTemplate[attribute])(item) })
            : compiled,
        {}
      );
      messages.push({
        "From": {
          "Email": emailSettings.settings.defaultFrom,
          "Name": emailSettings.settings.defaultFromName
        },
        "To": [
          {
            "Email": emailOptions.to,
            "Name": ""
          }
        ],
        "Subject": emailTemplate.subject,
        "TextPart": templatedAttributes['text'],
        "HTMLPart": templatedAttributes['html']
      });
    }
  });
  const request = mailjet
    .connect(emailSettings.providerOptions.publicApiKey , emailSettings.providerOptions.secretApiKey)
    .post("send", {'version': 'v3.1'})
    .request({ "Messages": [...messages] });
  request
    .then((result) => {
      return result.body;
    })
    .catch((err) => {
      console.log(err.statusCode);
      return err.statusCode;
    });


};

/**
 * @Deprecated
 * Promise to retrieve a composed HTML email.
 * @return {Promise}
 */
const compose = async ({ templateName, data }) => {
  strapi.log.debug(`⚠️: `, `The 'compose' function is deprecated and may be removed or changed in the future.`);

  if (!templateName) throw new Error("No email template's id provided");
  let composedHtml, composedText;
  try {
    const template = await strapi.query('email-template', 'email-designer').findOne({ name: templateName });
    composedHtml = _.template(decode(template.bodyHtml))({ ...data });
    composedText = _.template(decode(template.bodyText))({ ...data });
  } catch (error) {
    strapi.log.debug(error);
    throw new Error('Email template not found with id: ' + templateName);
  }

  return { composedHtml, composedText };
};

/**
 * @Deprecated
 * Promise to send a composed HTML email.
 * @return {Promise}
 */
const send = async ({ templateName, data, to, from, replyTo, bcc, subject }) => {
  strapi.log.debug(`⚠️: `, `The 'send' function is deprecated and may be removed or changed in the future.`);

  Object.entries({ to, from, replyTo }).forEach(([key, address]) => {
    if (!isValidEmail.test(address)) throw new Error(`Invalid "${key}" email address with value "${address}"`);
  });

  try {
    const { composedHtml = '', composedText = '' } = await strapi.plugins['email-designer'].services.email.compose({
      templateName,
      data,
    });

    await strapi.plugins['email'].services.email.send({
      to,
      from,
      replyTo,
      subject,
      bcc,
      html: composedHtml,
      text: composedText,
    });
  } catch (err) {
    strapi.log.debug(`📺: `, err);
    throw new Error(err);
  }
};

module.exports = {
  sendTemplatedEmail,
  sendBulkTemplatedEmail,
  compose,
  send,
};
