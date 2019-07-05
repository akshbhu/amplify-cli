import { create as createUtil } from './util';
import { map as convertToJavaTypes } from './value-mapper/mapper';
import { Compile, parse } from 'velocityjs';
import { map } from './value-mapper/mapper';
import { AppSyncVTLTemplate } from '..';
import * as JSON5 from 'json5';
import { Source } from 'graphql';

export type AppSyncSimulatorRequestContext = {
  jwt?: {
    iss?: string;
    sub?: string;
    'cognito:username'?: string;
  };
  request?: object;
};

export type AppSyncVTLRenderContext = {
  arguments: object,
  source: object,
  stash?: object,
  result?: any,
  prevResult?: any,
}

class VelocityTemplateParseError extends Error {}

export class VelocityTemplate {
  private compiler: Compile;
  private template;
  constructor(template: AppSyncVTLTemplate) {
    try {
      const ast = parse(template.content.toString());
      this.compiler = new Compile(ast, {
        valueMapper: map
      });
      this.template = template;
    } catch (e) {
      const lineDetails = `${e.hash.line}:${e.hash.loc.first_column}`;
      const fileName = template.path? `${template.path}:${lineDetails}`: lineDetails;
      const templateError = new VelocityTemplateParseError(`Error:Parse error on ${fileName}`)
      templateError.stack = e.stack;
      throw templateError;
    }
  }
  render(
    ctxValues: AppSyncVTLRenderContext,
    requestContext: AppSyncSimulatorRequestContext,
    info?: any,
  ): any {
    const context = this.buildRenderContext(ctxValues, requestContext, info);
    const templateResult = this.compiler.render(context);
    const stash = context.ctx.stash.toJSON()
    return {result: JSON5.parse(templateResult), stash };
  }
  private buildRenderContext(
    ctxValues: AppSyncVTLRenderContext,
    requestContext: any,
    info: any,

  ): any {
    const { source, arguments: argument, result, stash, prevResult } = ctxValues;

    const {
      jwt: { iss: issuer, sub, 'cognito:username': username },
      request
    } = requestContext;

    const util = createUtil();
    const args = convertToJavaTypes(argument);
    const identity = convertToJavaTypes({
      sub,
      issuer,
      username,
      sourceIp: ['0.0.0.0'],
      defaultStrategy: 'ALLOW',
      claims: requestContext.jwt
    });

    const vtlContext = {
      arguments: args,
      args,
      request: request ? { headers: request.headers } : {},
      identity,
      stash: convertToJavaTypes(stash || {}),
      source: convertToJavaTypes(source),
      result: convertToJavaTypes(result || {})
    };

    if(prevResult) {
      vtlContext['prev'] = convertToJavaTypes({
        result: prevResult
      })
    }

    return {
      util,
      utils: util,
      context: vtlContext,
      ctx: vtlContext
    };
  }
}
